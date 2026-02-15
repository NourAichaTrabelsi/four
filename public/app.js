/**
 * Client: WebRTC one-to-one video call with WebSocket signaling.
 * Uses native WebRTC APIs only; signaling is exclusively via WebSocket.
 */

(function () {
  const roomInput = document.getElementById('roomInput');
  const joinBtn = document.getElementById('joinBtn');
  const joinError = document.getElementById('joinError');
  const joinSection = document.getElementById('joinSection');
  const callSection = document.getElementById('callSection');
  const localVideo = document.getElementById('localVideo');
  const remoteVideo = document.getElementById('remoteVideo');
  const remoteLabel = document.getElementById('remoteLabel');
  const roomBadge = document.getElementById('roomBadge');
  const leaveBtn = document.getElementById('leaveBtn');
  const callStatus = document.getElementById('callStatus');

  let ws = null;
  let localStream = null;
  let pc = null;
  let roomId = null;
  let userId = null;
  let remoteUserId = null;

  const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

  function setJoinError(text) {
    joinError.textContent = text || '';
  }

  function setCallStatus(text, isError = false) {
    callStatus.textContent = text || '';
    callStatus.classList.toggle('error', isError);
    callStatus.classList.toggle('connected', text === 'Connected');
  }

  function showJoin() {
    joinSection.classList.remove('hidden');
    callSection.classList.add('hidden');
    setJoinError('');
  }

  function showCall() {
    joinSection.classList.add('hidden');
    callSection.classList.remove('hidden');
    roomBadge.textContent = `Room: ${roomId}`;
    setCallStatus('Connecting…');
  }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (localVideo.srcObject) localVideo.srcObject = null;
  }

  function closePeerConnection() {
    if (pc) {
      pc.close();
      pc = null;
    }
    if (remoteVideo.srcObject) remoteVideo.srcObject = null;
    remoteUserId = null;
  }

  function closeWs() {
    if (ws) {
      try {
        ws.send(JSON.stringify({ type: 'leave' }));
      } catch (_) {}
      ws.close();
      ws = null;
    }
  }

  function leave() {
    closePeerConnection();
    stopLocalStream();
    closeWs();
    roomId = null;
    userId = null;
    showJoin();
  }

  async function getLocalMedia() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    localVideo.srcObject = stream;
    return stream;
  }

  function createPeerConnection() {
    const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const connection = new RTCPeerConnection(config);

    connection.onicecandidate = (e) => {
      if (e.candidate && remoteUserId) {
        ws.send(JSON.stringify({ type: 'ice-candidate', to: remoteUserId, candidate: e.candidate }));
      }
    };

    connection.ontrack = (e) => {
      if (remoteVideo.srcObject !== e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
      }
    };

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') setCallStatus('Connected');
      if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
        setCallStatus('Connection problem. You may need to leave and rejoin.', true);
      }
    };

    return connection;
  }

  async function startCall(peerId) {
    remoteUserId = peerId;
    remoteLabel.textContent = 'Remote';
    if (!localStream) return;
    pc = createPeerConnection();
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
    } catch (err) {
      setCallStatus('Failed to create offer: ' + err.message, true);
    }
  }

  async function handleOffer(from, sdp) {
    remoteUserId = from;
    remoteLabel.textContent = 'Remote';
    if (!localStream) return;
    pc = createPeerConnection();
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', to: from, sdp: pc.localDescription }));
    } catch (err) {
      setCallStatus('Failed to handle offer: ' + err.message, true);
    }
  }

  async function handleAnswer(from, sdp) {
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      setCallStatus('Failed to set remote description: ' + err.message, true);
    }
  }

  function handleIceCandidate(from, candidate) {
    if (!pc) return;
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }

  joinBtn.addEventListener('click', async () => {
    const room = roomInput.value.trim();
    if (!room) {
      setJoinError('Enter a room name');
      return;
    }
    setJoinError('');
    joinBtn.disabled = true;

    try {
      localStream = await getLocalMedia();
    } catch (err) {
      setJoinError('Could not access camera or microphone: ' + err.message);
      joinBtn.disabled = false;
      return;
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', roomId: room }));
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (data.type) {
        case 'joined':
          roomId = data.roomId;
          userId = data.userId;
          showCall();
          // New joiner: do not create offer; wait for offer from the peer already in the room
          break;
        case 'peer-joined':
          // Existing peer: create offer and send to the new joiner
          if (!pc && data.userId !== userId) {
            startCall(data.userId);
          }
          break;
        case 'offer':
          handleOffer(data.from, data.sdp);
          break;
        case 'answer':
          handleAnswer(data.from, data.sdp);
          break;
        case 'ice-candidate':
          handleIceCandidate(data.from, data.candidate);
          break;
        case 'peer-left':
          setCallStatus('Other peer left the call.');
          closePeerConnection();
          break;
        case 'error':
          setJoinError(data.message);
          setCallStatus(data.message, true);
          break;
      }
    };

    ws.onerror = () => {
      setJoinError('WebSocket error');
      setCallStatus('Connection error', true);
    };

    ws.onclose = () => {
      joinBtn.disabled = false;
      if (callSection.classList.contains('hidden')) {
        stopLocalStream();
      }
    };
  });

  leaveBtn.addEventListener('click', leave);

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });
})();
