// public/script.js
class VideoConference {
    constructor() {
        this.socket = io("https://videocall.brandon.my");
        this.localStream = null;
        this.isVideoUser = false;
        this.animalName = '';
        this.roomId = '';
        this.peerConnections = new Map();
        this.remoteStreams = new Map();
        
        this.initializeEventListeners();
        this.showJoinModal();
    }

    initializeEventListeners() {
        // Join room
        document.getElementById('joinRoom').addEventListener('click', () => this.joinRoom());
        
        // Send message
        document.getElementById('sendMessage').addEventListener('click', () => this.sendMessage());
        document.getElementById('messageInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
        
        // Leave call
        document.getElementById('leaveCall').addEventListener('click', () => this.leaveCall());
        
        // Socket events
        this.socket.on('joined-as-video', (data) => this.handleJoinedAsVideo(data));
        this.socket.on('joined-as-chat', (data) => this.handleJoinedAsChat(data));
        this.socket.on('user-joined-video', (data) => this.handleUserJoinedVideo(data));
        this.socket.on('user-joined-chat', (data) => this.handleUserJoinedChat(data));
        this.socket.on('user-left-video', (data) => this.handleUserLeftVideo(data));
        this.socket.on('user-left-chat', (data) => this.handleUserLeftChat(data));
        this.socket.on('new-message', (data) => this.handleNewMessage(data));
        this.socket.on('room-full', () => this.handleRoomFull());
        
        // WebRTC signaling events
        this.socket.on('offer', (data) => this.handleOffer(data));
        this.socket.on('answer', (data) => this.handleAnswer(data));
        this.socket.on('ice-candidate', (data) => this.handleIceCandidate(data));
    }

    showJoinModal() {
        const modal = new bootstrap.Modal(document.getElementById('joinModal'));
        modal.show();
    }

    async joinRoom() {
        this.roomId = document.getElementById('roomId').value.trim() || 'default-room';
        
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 },
                audio: true
            });
            
            this.socket.emit('join-room', this.roomId);
            bootstrap.Modal.getInstance(document.getElementById('joinModal')).hide();
            
        } catch (error) {
            console.error('Error accessing media devices:', error);
            alert('Error accessing camera/microphone. Please check permissions. You can still join as chat-only.');
            // Join as chat-only if media access fails
            this.socket.emit('join-room', this.roomId);
            bootstrap.Modal.getInstance(document.getElementById('joinModal')).hide();
        }
    }

    handleJoinedAsVideo(data) {
        this.isVideoUser = true;
        this.animalName = data.animalName;
        this.updateUI(data);
        // Retry setupLocalVideo until tile is present in DOM
        const setupSelfVideo = () => {
            const videoElement = document.getElementById(`video-${this.socket.id}`);
            if (videoElement) {
                this.setupLocalVideo();
            } else {
                setTimeout(setupSelfVideo, 200);
            }
        };
        setupSelfVideo();
        this.enableChat();
        this.startWebRTCConnections(data.videoUsers);
    }

    handleJoinedAsChat(data) {
        this.isVideoUser = false;
        this.animalName = data.animalName;
        this.updateUI(data);
        this.enableChat();
        this.showChatOnlyMessage();
        // Stop local stream if any
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        // Ensure chat-only users can receive video feeds:
        this.startReceiveOnlyWebRTCConnections(data.videoUsers);
    }

    // NEW: For chat-only users, set up receive-only peer connections to all video users
    async startReceiveOnlyWebRTCConnections(videoUsers) {
        for (const user of videoUsers) {
            if (user.id !== this.socket.id) {
                await this.createPeerConnectionReceiveOnly(user.id);
            }
        }
    }

    // NEW: Create receive-only peer connection -- chat-only users do not send tracks
    async createPeerConnectionReceiveOnly(targetSocketId) {
        if (this.peerConnections.has(targetSocketId)) {
            return this.peerConnections.get(targetSocketId);
        }
        try {
            const configuration = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' }
                ]
            };
            const peerConnection = new RTCPeerConnection(configuration);
            this.peerConnections.set(targetSocketId, peerConnection);

            // Only set up remote stream handler
            peerConnection.ontrack = (event) => {
                const remoteStream = event.streams[0];
                this.remoteStreams.set(targetSocketId, remoteStream);
                const attachStream = () => {
                    const videoElement = document.getElementById(`video-${targetSocketId}`);
                    if (videoElement) {
                        videoElement.srcObject = remoteStream;
                    } else {
                        setTimeout(attachStream, 500);
                    }
                };
                attachStream();
            };
            // ICE candidates
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.socket.emit('ice-candidate', {
                        target: targetSocketId,
                        candidate: event.candidate
                    });
                }
            };

            // Always, joining user sends offer to all other video users and chat users (for receive-only too)
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            this.socket.emit('offer', {
                target: targetSocketId,
                offer: offer
            });
        } catch (error) {
            console.error('Error creating receive-only peer connection:', error);
        }
    }

    // Fix offer/answer logic: joining user sends offer, not by socketId comparison
    async startWebRTCConnections(videoUsers) {
        if (!this.isVideoUser) return;
        for (const user of videoUsers) {
            if (user.id !== this.socket.id) {
                // As joining user, always send offer to everyone else
                await this.createPeerConnection(user.id, true);
            }
        }
    }

    // Update: createPeerConnection takes asOfferInitiator flag (default false)
    async createPeerConnection(targetSocketId, asOfferInitiator = false) {
        if (this.peerConnections.has(targetSocketId)) {
            return this.peerConnections.get(targetSocketId);
        }
        try {
            const configuration = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' }
                ]
            };
            const peerConnection = new RTCPeerConnection(configuration);
            this.peerConnections.set(targetSocketId, peerConnection);
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => {
                    peerConnection.addTrack(track, this.localStream);
                });
            }
            peerConnection.ontrack = (event) => {
                const remoteStream = event.streams[0];
                this.remoteStreams.set(targetSocketId, remoteStream);
                const attachStream = () => {
                    const videoElement = document.getElementById(`video-${targetSocketId}`);
                    if (videoElement) {
                        videoElement.srcObject = remoteStream;
                    } else {
                        setTimeout(attachStream, 500);
                    }
                };
                attachStream();
            };
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.socket.emit('ice-candidate', {
                        target: targetSocketId,
                        candidate: event.candidate
                    });
                }
            };
            if (asOfferInitiator) {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                this.socket.emit('offer', {
                    target: targetSocketId,
                    offer: offer
                });
            }
        } catch (error) {
            console.error('Error creating peer connection:', error);
        }
    }

    async handleOffer(data) {
        try {
            const peerConnection = await this.createPeerConnection(data.from);
            await peerConnection.setRemoteDescription(data.offer);
            
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            this.socket.emit('answer', {
                target: data.from,
                answer: answer
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(data) {
        try {
            const peerConnection = this.peerConnections.get(data.from);
            if (peerConnection) {
                await peerConnection.setRemoteDescription(data.answer);
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(data) {
        try {
            const peerConnection = this.peerConnections.get(data.from);
            if (peerConnection) {
                await peerConnection.addIceCandidate(data.candidate);
            }
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    }

    enableChat() {
        document.getElementById('messageInput').disabled = false;
        document.getElementById('sendMessage').disabled = false;
        document.getElementById('messageInput').focus();
    }

    showChatOnlyMessage() {
        this.addMessage({
            animalName: 'System',
            message: 'You have joined as a chat-only participant. Video slots are full.',
            timestamp: new Date().toLocaleTimeString()
        }, true);
    }

    sendMessage() {
        const messageInput = document.getElementById('messageInput');
        const message = messageInput.value.trim();
        
        if (message) {
            this.socket.emit('send-message', message);
            messageInput.value = '';
        }
    }

    handleNewMessage(data) {
        const isOwnMessage = data.animalName === this.animalName;
        this.addMessage(data, isOwnMessage);
    }

    addMessage(data, isOwnMessage) {
        const chatMessages = document.getElementById('chatMessages');
        const messageDiv = document.createElement('div');
        
        messageDiv.className = `chat-message ${isOwnMessage ? 'message-own' : 'message-other'}`;
        messageDiv.innerHTML = `
            <div class="message-header">${data.animalName}</div>
            <div>${this.escapeHtml(data.message)}</div>
            <div class="message-time">${data.timestamp}</div>
        `;
        
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    loadMessages(messages) {
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.innerHTML = '';
        
        messages.forEach(message => {
            const isOwnMessage = message.animalName === this.animalName;
            this.addMessage(message, isOwnMessage);
        });
    }

    handleUserJoinedVideo(data) {
        this.updateUserLists(data.videoUsers, data.chatUsers);
        
        if (this.isVideoUser) {
            this.createPeerConnection(data.id);
        }
        
        this.addSystemMessage(`${data.animalName} joined the video call`);
    }

    handleUserJoinedChat(data) {
        this.updateUserLists(data.videoUsers, data.chatUsers);
        this.addSystemMessage(`${data.animalName} joined the chat`);
    }

    handleUserLeftVideo(data) {
        this.updateUserLists(data.videoUsers, data.chatUsers);
        this.cleanupPeerConnection(data.id);
        this.addSystemMessage(`${data.animalName} left the video call`);
    }

    handleUserLeftChat(data) {
        this.updateUserLists(data.videoUsers, data.chatUsers);
        this.addSystemMessage(`${data.animalName} left the chat`);
    }

    cleanupPeerConnection(socketId) {
        const peerConnection = this.peerConnections.get(socketId);
        if (peerConnection) {
            peerConnection.close();
            this.peerConnections.delete(socketId);
        }
        this.remoteStreams.delete(socketId);
        
        // Remove video element
        const videoElement = document.getElementById(`video-${socketId}`);
        if (videoElement) {
            videoElement.remove();
        }
    }

    addSystemMessage(message) {
        this.addMessage({
            animalName: 'System',
            message: message,
            timestamp: new Date().toLocaleTimeString()
        }, false);
    }

    handleRoomFull() {
        alert('Room is full! Please try another room.');
        this.showJoinModal();
    }

    leaveCall() {
        if (this.isVideoUser && this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }
        
        // Clean up all peer connections
        this.peerConnections.forEach((pc, socketId) => {
            pc.close();
        });
        this.peerConnections.clear();
        this.remoteStreams.clear();
        
        this.socket.disconnect();
        window.location.reload();
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    updateUI(data) {
        // Update the UI based on new state (animalName, isVideoUser, etc.)
        // Placeholder to prevent errors if not yet implemented
        console.log("UI updated:", data);
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new VideoConference();
});

// Handle page refresh/close
window.addEventListener('beforeunload', () => {
    // Socket.io will handle disconnection automatically
});