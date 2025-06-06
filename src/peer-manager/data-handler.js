// src/peer-manager/data-handler.js

/**
 * Handles incoming peer data parsing and routing
 */
export class DataHandler {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.eventHandlers = options.eventHandlers || {};
    this.peers = options.peers; // Reference to main peers Map
    this.signalingOptimizer = options.signalingOptimizer;
    this.pendingConnections = options.pendingConnections;
    this.peerConnectionAttempts = options.peerConnectionAttempts;
    
    // Add tracking for relay signals
    this.pendingRelaySignals = new Map(); // Track pending relay signals by target peer
    this.relayTimeouts = new Map(); // Track timeouts for relay signals
    this.maxRelayTimeout = 10000; // 10 seconds timeout for relay signals
    this.maxRelayPathLength = 3; // Prevent infinite relay loops
  }

  /**
   * Handles incoming data from a peer
   * @param {Buffer|string} data - Raw data from peer
   * @param {string} remotePeerId - Peer ID that sent the data
   */
  handlePeerData(data, remotePeerId) {
    let parsedData;
    const dataString = data.toString();
    try {
      parsedData = JSON.parse(dataString);
    } catch (e) {
      // Log the error for better debugging instead of silently ignoring it
      console.error(`Error parsing JSON data from ${remotePeerId}:`, e);
      console.error(`Problematic data: ${dataString.substring(0, 100)}${dataString.length > 100 ? '...' : ''}`);
      
      // Emit as a generic 'message' event (as per previous behavior for non-JSON)
      if (this.eventHandlers['message']) {
        this.eventHandlers['message']({ from: remotePeerId, data: dataString });
      } else {
        console.log(`Received non-JSON data from ${remotePeerId} (no 'message' handler)`);
      }
      return; // Stop processing if not valid JSON for structured messages
    }

    // Handle connection rejection messages
    if (parsedData && parsedData.type === 'connection_rejected') {
      this.handleConnectionRejection(parsedData, remotePeerId);
      return;
    }

    // Handle optimized relay signals from SignalingOptimizer
    if (parsedData && parsedData.type === 'optimized_relay_signal') {
      this.signalingOptimizer.handleOptimizedRelaySignal(parsedData, remotePeerId);
      return;
    }
    
    // Handle optimized relay confirmations
    if (parsedData && parsedData.type === 'optimized_relay_confirmation') {
      // These are handled internally by SignalingOptimizer, no need to pass to application
      return;
    }
    
    // Handle batched signals from SignalingOptimizer
    if (parsedData && parsedData.type === 'batched_signals') {
      if (parsedData.signals && Array.isArray(parsedData.signals)) {
        console.log(`Received batch of ${parsedData.signals.length} signals from ${parsedData.from}`);
        // Process each signal in the batch
        parsedData.signals.forEach(signal => {
          if (this.eventHandlers['signal']) {
            this.eventHandlers['signal']({ from: parsedData.from, signal });
          }
        });
      }
      return;
    }

    // Handle relay_signal messages - relay WebRTC signaling data through peers
    if (parsedData && parsedData.type === 'relay_signal') {
      this.handleRelaySignal(parsedData, remotePeerId);
      return;
    }
    
    // Handle relay acknowledgments
    if (parsedData && parsedData.type === 'relay_ack') {
      const latency = parsedData.receivedTimestamp - parsedData.originalTimestamp;
      console.log(`Relay to ${parsedData.from} was acknowledged (latency: ${latency}ms)`);
      return; // Don't pass ack messages to application layer
    }
    
    // Handle relay failures
    if (parsedData && parsedData.type === 'relay_failure') {
      console.warn(`Relay to ${parsedData.targetPeer} failed: ${parsedData.reason}`);
      return; // Don't pass failure messages to application layer
    }

    if (parsedData && parsedData.type === 'reconnection_data') {
      this.handleReconnectionData(parsedData, remotePeerId);
    } else if (parsedData && parsedData.type === 'gossip') {
      // Forward to gossip protocol handler
      if (this.eventHandlers['gossip']) {
        this.eventHandlers['gossip'](parsedData, remotePeerId);
      }
    } else if (parsedData && parsedData.type === 'gossip_ack') {
      // Handle gossip acknowledgments internally but don't forward to application
      if (this.eventHandlers['gossip']) {
        this.eventHandlers['gossip'](parsedData, remotePeerId);
      }
    } else if (parsedData && parsedData.type === 'kademlia_rpc_response') {
      // Fallback for other structured messages if not Kademlia response or no handler
      if (this.eventHandlers['message']) {
        this.eventHandlers['message']({ from: remotePeerId, data: parsedData });
      }
    } else if (parsedData && parsedData.type === 'kademlia_rpc') {
      // REMOVED: Don't pass internal Kademlia RPC messages to application layer
      console.log(`DataHandler: Filtered out internal Kademlia RPC message from ${remotePeerId}`);
      // These are handled internally by the Kademlia system, don't expose to application
      if (this.eventHandlers['kademlia_rpc']) {
        this.eventHandlers['kademlia_rpc'](parsedData, remotePeerId);
      }
    } else if (parsedData) {
      // Emit as a generic 'message' event if it's structured but not internal protocol messages
      if (this.eventHandlers['message']) {
        this.eventHandlers['message']({ from: remotePeerId, data: parsedData });
      }
    }
  }

  /**
   * Handles connection rejection messages
   * @param {Object} parsedData - Parsed connection rejection data
   * @param {string} remotePeerId - Peer that sent the rejection
   */
  handleConnectionRejection(parsedData, remotePeerId) {
    console.log(`Connection rejected by ${parsedData.from}: ${parsedData.reason}`);
    
    // Clean up any pending connection attempts
    this.pendingConnections.delete(parsedData.from);
    this.peerConnectionAttempts.delete(parsedData.from);
    
    // If alternative peers were provided, store them for potential future connections
    if (parsedData.alternativePeers && parsedData.alternativePeers.length > 0) {
      console.log(`Received ${parsedData.alternativePeers.length} alternative peers from ${parsedData.from}`);
      
      // Emit event with alternative peers for the application to handle
      if (this.eventHandlers['connection_rejected']) {
        this.eventHandlers['connection_rejected']({
          rejectedBy: parsedData.from,
          reason: parsedData.reason,
          alternativePeers: parsedData.alternativePeers
        });
      }
    }
  }

  /**
   * Handles relay signal messages
   * @param {Object} parsedData - Parsed relay signal data
   * @param {string} remotePeerId - Peer that sent the relay
   */
  handleRelaySignal(parsedData, remotePeerId) {
    if (parsedData.to && parsedData.from && parsedData.signal) {
      // Add received timestamp for tracking relay timing
      const receivedTime = Date.now();
      const relayLatency = parsedData.timestamp ? (receivedTime - parsedData.timestamp) : 'unknown';
      
      // Validate relay path to prevent loops
      const relayPath = parsedData.relayPath || [];
      if (relayPath.includes(this.localPeerId)) {
        console.warn(`Detected relay loop for signal from ${parsedData.from} to ${parsedData.to}, dropping`);
        this.sendRelayFailure(remotePeerId, parsedData.from, parsedData.to, 'Relay loop detected');
        return;
      }
      
      if (relayPath.length >= this.maxRelayPathLength) {
        console.warn(`Relay path too long (${relayPath.length}) for signal from ${parsedData.from} to ${parsedData.to}, dropping`);
        this.sendRelayFailure(remotePeerId, parsedData.from, parsedData.to, 'Relay path too long');
        return;
      }
      
      if (parsedData.to === this.localPeerId) {
        // Signal is for us - process it directly and acknowledge receipt
        console.log(`Received relayed signal from ${parsedData.from} via ${relayPath.length > 0 ? relayPath.join(' -> ') + ' -> ' : ''}${remotePeerId} (latency: ${relayLatency}ms)`);
        
        // Clear any pending relay tracking for this signal
        const signalKey = `${parsedData.from}-${parsedData.to}`;
        if (this.pendingRelaySignals.has(signalKey)) {
          clearTimeout(this.relayTimeouts.get(signalKey));
          this.pendingRelaySignals.delete(signalKey);
          this.relayTimeouts.delete(signalKey);
        }
        
        // Process the signal data
        if (this.eventHandlers['signal']) {
          this.eventHandlers['signal']({ from: parsedData.from, signal: parsedData.signal });
        }
        
        // Send acknowledgment back to the sender
        try {
          const peer = this.peers.get(remotePeerId);
          if (peer) {
            peer.send(JSON.stringify({
              type: 'relay_ack',
              to: parsedData.from,
              from: this.localPeerId,
              originalTimestamp: parsedData.timestamp,
              receivedTimestamp: receivedTime,
              relayPath: relayPath
            }));
          }
        } catch (error) {
          console.error(`Failed to send relay acknowledgment to ${remotePeerId}:`, error);
        }
      } else {
        // Signal is for another peer - relay it further if we can
        const newRelayPath = [...relayPath, this.localPeerId];
        console.log(`Relaying signal from ${parsedData.from} to ${parsedData.to} (path: ${newRelayPath.join(' -> ')})`);
        
        const targetPeer = this.peers.get(parsedData.to);
        if (targetPeer && targetPeer.connected) {
          try {
            // Track this relay attempt
            const signalKey = `${parsedData.from}-${parsedData.to}`;
            this.trackRelaySignal(signalKey, parsedData, remotePeerId);
            
            // Preserve original timestamp for accurate latency measurement
            targetPeer.send(JSON.stringify({
              ...parsedData,
              relayPath: newRelayPath
            }));
            console.log(`Successfully relayed signal to ${parsedData.to}`);
          } catch (error) {
            console.error(`Error relaying signal to ${parsedData.to}:`, error);
            this.sendRelayFailure(remotePeerId, parsedData.from, parsedData.to, error.message || 'Send error');
          }
        } else {
          console.warn(`Cannot relay signal to ${parsedData.to}: not connected`);
          this.sendRelayFailure(remotePeerId, parsedData.from, parsedData.to, 'Peer not connected');
          
          // Try to find alternative relay paths
          this.findAlternativeRelayPath(parsedData, remotePeerId, newRelayPath);
        }
      }
    }
  }

  /**
   * Track relay signal for timeout detection
   */
  trackRelaySignal(signalKey, parsedData, relayPeerId) {
    // Clear any existing timeout for this signal
    if (this.relayTimeouts.has(signalKey)) {
      clearTimeout(this.relayTimeouts.get(signalKey));
    }
    
    this.pendingRelaySignals.set(signalKey, {
      signal: parsedData,
      relayPeer: relayPeerId,
      timestamp: Date.now()
    });
    
    // Set timeout for this relay
    const timeoutId = setTimeout(() => {
      console.warn(`Relay signal timeout for ${signalKey}`);
      this.handleRelayTimeout(signalKey);
    }, this.maxRelayTimeout);
    
    this.relayTimeouts.set(signalKey, timeoutId);
  }

  /**
   * Handle relay signal timeout
   */
  handleRelayTimeout(signalKey) {
    const pendingRelay = this.pendingRelaySignals.get(signalKey);
    if (pendingRelay) {
      console.warn(`Relay signal timed out after ${this.maxRelayTimeout}ms: ${signalKey}`);
      
      // Clean up
      this.pendingRelaySignals.delete(signalKey);
      this.relayTimeouts.delete(signalKey);
      
      // Send failure notification
      this.sendRelayFailure(
        pendingRelay.relayPeer,
        pendingRelay.signal.from,
        pendingRelay.signal.to,
        'Relay timeout'
      );
      
      // Try to find alternative relay paths if available
      this.findAlternativeRelayPath(pendingRelay.signal, pendingRelay.relayPeer, pendingRelay.signal.relayPath || []);
    }
  }

  /**
   * Find alternative relay paths when direct relay fails
   */
  findAlternativeRelayPath(signalData, originalRelayPeer, currentPath) {
    const targetPeer = signalData.to;
    const availablePeers = Array.from(this.peers.keys()).filter(peerId => 
      peerId !== this.localPeerId && 
      peerId !== targetPeer && 
      peerId !== originalRelayPeer &&
      !currentPath.includes(peerId) &&
      this.peers.get(peerId)?.connected
    );
    
    if (availablePeers.length > 0) {
      const alternativePeer = availablePeers[0]; // Use first available peer
      console.log(`Trying alternative relay path through ${alternativePeer} for signal from ${signalData.from} to ${targetPeer}`);
      
      try {
        const peer = this.peers.get(alternativePeer);
        if (peer) {
          peer.send(JSON.stringify({
            ...signalData,
            relayPath: [...currentPath, this.localPeerId]
          }));
        }
      } catch (error) {
        console.error(`Failed to send signal through alternative relay ${alternativePeer}:`, error);
      }
    } else {
      console.warn(`No alternative relay paths available for signal from ${signalData.from} to ${targetPeer}`);
    }
  }

  /**
   * Handles reconnection data messages
   * @param {Object} parsedData - Parsed reconnection data
   * @param {string} remotePeerId - Peer that sent the data
   */
  handleReconnectionData(parsedData, remotePeerId) {
    // Store reconnection data for later use if disconnected
    console.log(`Received reconnection data from ${remotePeerId} with ${parsedData.peers.length} alternative peers`);
    
    if (this.eventHandlers['reconnection_data']) {
      this.eventHandlers['reconnection_data'](parsedData, remotePeerId);
    }
    
    // Emit a special event that applications can listen for
    if (this.eventHandlers['peer:evicted']) {
      this.eventHandlers['peer:evicted']({ 
        reason: parsedData.reason, 
        alternativePeers: parsedData.peers 
      });
    }
  }

  /**
   * Sends a relay failure notification
   * @param {string} relayPeerId - Peer that attempted the relay
   * @param {string} originalSender - Original sender of the message
   * @param {string} targetPeer - Target peer that couldn't be reached
   * @param {string} reason - Reason for failure
   */
  sendRelayFailure(relayPeerId, originalSender, targetPeer, reason) {
    try {
      const peer = this.peers.get(relayPeerId);
      if (peer) {
        peer.send(JSON.stringify({
          type: 'relay_failure',
          to: originalSender,
          from: this.localPeerId,
          targetPeer: targetPeer,
          reason: reason,
          timestamp: Date.now()
        }));
        console.log(`Sent relay failure notification to ${relayPeerId}: ${reason}`);
      }
    } catch (error) {
      console.error(`Failed to send relay failure notification:`, error);
    }
  }

  /**
   * Clean up method to clear timeouts when shutting down
   */
  cleanup() {
    // Clear all pending relay timeouts
    for (const timeoutId of this.relayTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.relayTimeouts.clear();
    this.pendingRelaySignals.clear();
  }
}
