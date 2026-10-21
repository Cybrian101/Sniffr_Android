import { useState, useEffect, useRef } from 'react';
import { promptCreatePet } from '../utils/noPet';
import { useSocket } from '../context/SocketContext';
import { usePermissions } from '../context/PermissionContext';
import api from '../services/api';

import { publicAsset } from '../utils/publicPath';
export default function CallModal({
  type = 'audio',
  partnerName,
  partnerUsername,
  partnerAvatar,
  partnerPetId,
  isIncoming = false,
  callId: initialCallId = null,
  toUserId = null,
  onEnd
}) {
  // Reactive `socket` state (not `getSocket()`) so this component always
  // signals through the current live connection -- see CallContext.jsx for
  // the full reasoning; same class of bug, fixed the same way here for
  // consistency and to survive a reconnect mid-call.
  const { socket } = useSocket();
  const { requestFeaturePermission } = usePermissions();

  const [status, setStatus] = useState(isIncoming ? 'ringing' : 'dialing'); // dialing | ringing | connected | ended
  // Set when the user (or the OS) denies mic/camera access -- distinct from
  // 'ended' so the UI can show *why* the call didn't go through instead of
  // just "Call ended", and distinct from connectionLost (a network issue,
  // not a permissions one).
  const [permissionDenied, setPermissionDenied] = useState(null); // null | 'microphone' | 'camera'
  const [duration, setDuration] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(type === 'video');
  const [speakerOn, setSpeakerOn] = useState(true);
  // Whether the OTHER party has muted their mic -- driven by the
  // call_mute_state relay, not inferred from silence.
  const [remoteMuted, setRemoteMuted] = useState(false);

  // Network reconnect handling: a temporary ICE disconnect shouldn't kill
  // the call outright -- `reconnecting` shows a non-alarming banner while
  // we try to recover, `connectionLost` is only set once we give up.
  const [reconnecting, setReconnecting] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);

  const [callId, setCallId] = useState(initialCallId);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  // Audio-only calls render no <video> element at all, so remoteVideoRef
  // is always null for them -- pc.ontrack had nothing to attach the
  // remote stream to, meaning audio calls connected but played nothing.
  // This element is always mounted (hidden) so audio calls always have
  // somewhere to play the remote stream; video calls keep using the
  // visible <video> element instead (see pc.ontrack below).
  const remoteAudioRef = useRef(null);
  const localStreamRef = useRef(null);
  const pcRef = useRef(null);
  const durationIntervalRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  // Tracks whether the initial offer/answer has already gone out, so the
  // onnegotiationneeded handler (added for ICE restart) doesn't fire on
  // the very first negotiation -- that one is already handled explicitly
  // by startPeerConnection / the webrtc_offer listener below.
  const hasNegotiatedOnceRef = useRef(false);
  // Set only when the user taps Accept on an incoming call. Until then an
  // incoming offer is ignored: answering it would open the microphone/camera
  // while the phone is still ringing. (The server also relays nothing
  // before the call is accepted.) A ref, because the socket handlers below
  // are registered once and would otherwise see a stale status.
  const acceptedRef = useRef(false);
  // Guards the call_initiate emit below against firing more than once for
  // the same outgoing call. Without this, anything that makes the `socket`
  // reference change while still ringing -- React StrictMode's dev-only
  // double-invoke of this effect, or a real socket.io reconnect (a wifi
  // blip, tab backgrounded) -- re-ran the whole effect body, including the
  // unconditional emit, sending a SECOND call_initiate. The server has no
  // way to know these are "the same" call: it creates a second callId,
  // busies the callee a second time, and re-emits call_ringing with the
  // new id -- but call_connected (sent to callerSocketId from whichever
  // activeCalls entry the callee actually accepted) can land for either
  // id depending on timing, and the UI showed "Ringing..." forever because
  // the callId this component ended up tracking didn't match the one the
  // callee actually answered. Listeners still need to be torn down and
  // re-attached on the new socket (that part of the effect re-running is
  // correct and necessary) -- only the one-time "start this call" action
  // must not repeat.
  const callInitiatedRef = useRef(false);
  // H13: addIceCandidate() isn't safe to call until setRemoteDescription()
  // has resolved -- a candidate that arrives (over the socket, so there's
  // no ordering guarantee relative to the offer/answer exchange) before
  // that point used to just be silently dropped (`if (pcRef.current)` was
  // the only guard, and pc existing isn't the same as it having a remote
  // description yet). Queue anything that arrives too early and flush it
  // the moment the remote description is actually set.
  const remoteDescSetRef = useRef(false);
  const pendingCandidatesRef = useRef([]);
  const drainPendingCandidates = async () => {
    if (!pcRef.current || !remoteDescSetRef.current) return;
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('[Call] Queued remote ICE candidate added');
      } catch (err) {
        console.error('[Call] Error adding queued ICE candidate:', err);
      }
    }
  };

  // Initialize call if outgoing
  useEffect(() => {
    if (!socket) return;

    const handleRinging = ({ callId }) => {
      setCallId(callId);
      setStatus('ringing');
    };

    // The server broadcasts 'call_connected' to BOTH parties once the
    // callee accepts -- so this fires on both sides. Only the original
    // caller may create + send the initial offer here; the callee's
    // RTCPeerConnection is created lazily by the incoming webrtc_offer
    // handler below instead. Without this isPeerConnection role split,
    // both sides independently called startPeerConnection(), each
    // creating its own RTCPeerConnection and firing its own offer at the
    // other -- a WebRTC "glare" that orphans one connection and can push
    // the other into an invalid signaling state (setRemoteDescription
    // rejected because the local side already has its own local offer).
    // That race was a likely cause of connected-but-no-audio calls.
    const handleConnected = () => {
      console.log('[Call] call_connected received, isIncoming:', isIncoming);
      setStatus('connected');
      if (!isIncoming) {
        startPeerConnection();
      }
    };

    const handleRejected = () => {
      console.log('[Call] call_rejected received');
      setStatus('ended');
      cleanupCall();
      setTimeout(() => onEnd?.(), 1000);
    };

    const handleEnded = () => {
      console.log('[Call] call_ended received');
      setStatus('ended');
      cleanupCall();
      setTimeout(() => onEnd?.(), 1000);
    };

    const handleRemoteMuteState = ({ muted }) => {
      console.log('[Call] Remote party is now', muted ? 'muted' : 'unmuted');
      setRemoteMuted(muted);
    };

    const handleOffer = async ({ sdp }) => {
      // Offers only ever go caller -> callee, and only after Accept.
      if (!isIncoming || !acceptedRef.current) {
        console.warn('[Call] Ignoring an offer received before the call was accepted');
        return;
      }
      console.log('[Call] Offer received');
      try {
        if (!pcRef.current) await setupPeerConnection();
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        remoteDescSetRef.current = true;
        await drainPendingCandidates();
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit('webrtc_answer', { to: toUserId, sdp: answer });
        console.log('[Call] Answer created and sent');
        hasNegotiatedOnceRef.current = true;
      } catch (err) {
        console.error('[Call] Error handling WebRTC offer:', err);
      }
    };

    const handleAnswer = async ({ sdp }) => {
      console.log('[Call] Answer received');
      try {
        if (pcRef.current) {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
          remoteDescSetRef.current = true;
          await drainPendingCandidates();
        }
      } catch (err) {
        console.error('[Call] Error handling WebRTC answer:', err);
      }
    };

    const handleIceCandidate = async ({ candidate }) => {
      // H13: queue instead of dropping when the remote description hasn't
      // landed yet -- see the drainPendingCandidates/remoteDescSetRef note
      // above. Signaling events have no ordering guarantee, so a candidate
      // generated right after the offer/answer can easily arrive first.
      if (!pcRef.current || !remoteDescSetRef.current) {
        pendingCandidatesRef.current.push(candidate);
        console.log('[Call] Remote ICE candidate queued (no remote description yet)');
        return;
      }
      try {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('[Call] Remote ICE candidate added');
      } catch (err) {
        console.error('[Call] Error adding ICE candidate:', err);
      }
    };

    // H13: the server auto-cancels an unanswered outgoing call after its
    // ring timeout (server/socket/calls.js, RING_TIMEOUT_MS) -- without a
    // listener here the caller's UI just stayed on "Ringing..." forever,
    // with no indication the call was actually long dead.
    const handleTimeout = () => {
      console.log('[Call] call_timeout received');
      setStatus('ended');
      cleanupCall();
      setTimeout(() => onEnd?.(), 1000);
    };

    // The person being called is already on another call.
    const handleBusy = () => {
      console.log('[Call] call_busy received');
      setStatus('ended');
      cleanupCall();
      setTimeout(() => onEnd?.(), 1000);
    };

    // H13: a DIFFERENT device/tab of the same callee answered first -- this
    // one was shown the same incoming-call ring (correctly, every device
    // should ring) but never actually joined the call, so it just closes
    // quietly instead of sitting in a stale "connected" state with no media.
    const handleAnsweredElsewhere = () => {
      console.log('[Call] call_answered_elsewhere received');
      cleanupCall();
      onEnd?.();
    };

    // The server refused to start the call (blocked, busy partner, or no
    // pet profile yet -- then the "create your pet" prompt opens).
    const handleCallError = (payload) => {
      console.log('[Call] call_error received', payload?.code || payload?.message);
      if (payload?.code === 'NO_PET') promptCreatePet();
      setStatus('ended');
      cleanupCall();
      setTimeout(() => onEnd?.(), payload?.code === 'NO_PET' ? 0 : 1000);
    };

    socket.on('call_error', handleCallError);
    socket.on('call_ringing', handleRinging);
    socket.on('call_connected', handleConnected);
    socket.on('call_rejected', handleRejected);
    socket.on('call_ended', handleEnded);
    socket.on('call_timeout', handleTimeout);
    socket.on('call_busy', handleBusy);
    socket.on('call_answered_elsewhere', handleAnsweredElsewhere);
    socket.on('call_mute_state', handleRemoteMuteState);

    // WebRTC Signaling listeners
    socket.on('webrtc_offer', handleOffer);
    socket.on('webrtc_answer', handleAnswer);
    socket.on('webrtc_ice_candidate', handleIceCandidate);

    // If outgoing, initiate the call -- exactly once (see callInitiatedRef).
    if (!isIncoming && toUserId && !callInitiatedRef.current) {
      callInitiatedRef.current = true;
      console.log('[Call] Initiating outgoing call to', toUserId);
      socket.emit('call_initiate', { to: toUserId, type });
    }

    return () => {
      socket.off('call_error', handleCallError);
      socket.off('call_ringing', handleRinging);
      socket.off('call_connected', handleConnected);
      socket.off('call_rejected', handleRejected);
      socket.off('call_ended', handleEnded);
      socket.off('call_timeout', handleTimeout);
      socket.off('call_busy', handleBusy);
      socket.off('call_answered_elsewhere', handleAnsweredElsewhere);
      socket.off('call_mute_state', handleRemoteMuteState);
      socket.off('webrtc_offer', handleOffer);
      socket.off('webrtc_answer', handleAnswer);
      socket.off('webrtc_ice_candidate', handleIceCandidate);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [socket, isIncoming, toUserId]);

  // A denied mic/camera permission ends the call the same way a normal
  // hang-up does, just with a brief "why" shown first (see permissionDenied
  // state) instead of leaving a track-less call sitting in 'connected'.
  useEffect(() => {
    if (!permissionDenied) return;
    const t = setTimeout(() => handleEnd(), 1800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionDenied]);

  // Handle Call connected duration timer
  useEffect(() => {
    if (status === 'connected') {
      durationIntervalRef.current = setInterval(() => {
        setDuration(d => d + 1);
      }, 1000);
    } else {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
    }
    return () => {
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    };
  }, [status]);

  // Acquire local media streams. Goes through the same feature-permission
  // flow as every other capability in the app (see PermissionContext) --
  // previously this called getUserMedia directly, which still triggers the
  // OS/browser's native prompt, but silently produced a "connected" call
  // with zero local tracks on denial instead of telling the user why or
  // ending the call. A denial here now surfaces as a real UI state
  // (permissionDenied) and ends the call.
  const acquireLocalMedia = async () => {
    try {
      const micGranted = await requestFeaturePermission('microphone', type === 'video' ? 'videoCall' : 'audioCall');
      if (!micGranted) {
        setPermissionDenied('microphone');
        return null;
      }
      if (type === 'video') {
        const camGranted = await requestFeaturePermission('camera', 'videoCall');
        if (!camGranted) {
          setPermissionDenied('camera');
          return null;
        }
      }

      const constraints = {
        audio: true,
        video: type === 'video' ? { width: 320, height: 240 } : false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      console.log('[Call] Local media acquired:', stream.getTracks().map(t => t.kind));
      if (localVideoRef.current && type === 'video') {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (err) {
      console.error('[Call] Error acquiring media streams:', err);
      // getUserMedia can still fail/be denied here even after the
      // permission-service check above resolved 'granted' (e.g. the OS
      // prompt itself was dismissed at the native level, or no physical
      // device is present) -- still worth surfacing as a real UI state
      // rather than a silently track-less "connected" call.
      setPermissionDenied(type === 'video' ? 'camera' : 'microphone');
      return null;
    }
  };

  // TURN credentials must never ship in the client bundle -- fetched fresh
  // from the server (which reads them from env vars) each time a peer
  // connection is set up. Falls back to STUN-only if the endpoint fails or
  // no TURN is configured server-side, so calls still work exactly as
  // before on networks where STUN alone is enough.
  const fetchIceServers = async () => {
    try {
      const res = await api.get('/calls/ice-servers');
      if (res?.iceServers?.length) {
        console.log('[Call] ICE servers loaded:', res.iceServers.map(s => Array.isArray(s.urls) ? s.urls : [s.urls]).flat());
        return res.iceServers;
      }
    } catch (err) {
      console.error('[Call] Failed to fetch ICE servers, falling back to STUN-only:', err);
    }
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  };

  // Setup WebRTC PeerConnection
  const setupPeerConnection = async () => {
    const iceServers = await fetchIceServers();
    const pc = new RTCPeerConnection({ iceServers });

    const stream = localStreamRef.current || (await acquireLocalMedia());
    if (stream) {
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
        console.log('[Call] Local track added:', track.kind);
      });
    } else {
      console.error('[Call] No local media stream available -- getUserMedia failed or was denied. No tracks will be sent.');
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        console.log('[Call] Local ICE candidate generated, sending');
        socket.emit('webrtc_ice_candidate', { to: toUserId, candidate: event.candidate });
      }
    };

    // Audio-only calls render no <video> element at all (see the JSX --
    // the visible <video> only exists in the type === 'video' branch), so
    // remoteVideoRef was always null for them and this handler silently
    // did nothing: the call would connect but nothing would ever play.
    // Video calls keep using the visible <video> element (which carries
    // both tracks); audio calls use the always-mounted hidden <audio>
    // element instead.
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      // .muted here reflects whether the RECEIVED track is actually
      // getting data -- readyState alone only confirms the track object
      // exists, not that anything is arriving over the wire.
      console.log('[Call] Remote track received:', event.track.kind, 'readyState:', event.track.readyState, 'muted:', event.track.muted);
      if (!remoteStream) return;
      const targetEl = type === 'video' && remoteVideoRef.current ? remoteVideoRef.current : remoteAudioRef.current;
      if (targetEl) {
        targetEl.srcObject = remoteStream;
        // autoPlay is already set on both elements, but some browsers/
        // WebViews (autoplay-policy-restricted, or a play() call not
        // directly inside a user-gesture call stack) need an explicit
        // play() call.
        targetEl.play?.()
          .then(() => {
            console.log('[Call] Remote media playback started (play() resolved)');
          })
          .catch(err => {
            console.error('[Call] Remote media element failed to play (possible autoplay/gesture block):', err);
          });
      }
    };

    // ── Network reconnect handling ──────────────────────────────
    // 'disconnected' is usually a transient blip (wifi hiccup, network
    // switch) -- give it a chance to recover on its own before treating
    // the call as dead. 'failed' means it's not coming back.
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log('[Call] ICE connection state changed:', state);

      if (state === 'disconnected') {
        setReconnecting(true);

        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          // Still not back after the grace window -- give up.
          handleConnectionLost();
        }, 18000);

        try {
          pc.restartIce();
        } catch (err) {
          console.error('Failed to restart ICE:', err);
        }
      } else if (state === 'failed') {
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        handleConnectionLost();
      } else if (state === 'connected' || state === 'completed') {
        // Either a fresh connection, or a recovery after 'disconnected'.
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        setReconnecting(false);
      }
    };

    // Separate from iceConnectionState above: this reflects the OVERALL
    // peer connection (ICE + DTLS + certificate checks combined), and is
    // the most reliable single signal for "is media actually flowing".
    // Once it reaches 'connected', log which tracks each side actually
    // negotiated -- if a sender/receiver shows "no track", that's the
    // exact point where audio/video is silently missing despite a fully
    // connected transport.
    pc.onconnectionstatechange = () => {
      console.log('[Call] Peer connection state changed:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        // readyState alone only confirms a track object exists, not that
        // data is actually arriving -- .muted on a RECEIVER track means
        // "no data flowing right now" even while readyState stays 'live'.
        console.log('[Call] Senders:', pc.getSenders().map(s => s.track ? `${s.track.kind}(${s.track.readyState}, muted:${s.track.muted})` : 'no track'));
        console.log('[Call] Receivers:', pc.getReceivers().map(r => r.track ? `${r.track.kind}(${r.track.readyState}, muted:${r.track.muted})` : 'no track'));
      }
    };

    // pc.restartIce() alone doesn't push anything over signaling -- it
    // just flags the connection so the NEXT offer includes fresh ICE
    // credentials. Only the original caller re-offers here, so both
    // sides don't race to send competing offers; the callee just waits
    // for that new offer via the existing webrtc_offer listener below,
    // exactly like the initial call setup.
    pc.onnegotiationneeded = async () => {
      if (!hasNegotiatedOnceRef.current || isIncoming) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket?.emit('webrtc_offer', { to: toUserId, sdp: offer });
      } catch (err) {
        console.error('Failed to renegotiate after ICE restart:', err);
      }
    };

    pcRef.current = pc;
    return pc;
  };

  const startPeerConnection = async () => {
    try {
      await setupPeerConnection();
      const offer = await pcRef.current.createOffer();
      await pcRef.current.setLocalDescription(offer);
      socket?.emit('webrtc_offer', { to: toUserId, sdp: offer });
      console.log('[Call] Offer created and sent');
      hasNegotiatedOnceRef.current = true;
    } catch (err) {
      console.error('[Call] Failed to create WebRTC offer:', err);
    }
  };

  const handleAccept = async () => {
    if (!socket || !callId) return;
    console.log('[Call] Call accepted');
    acceptedRef.current = true;
    setStatus('connected');
    // call_accept fires BEFORE acquiring media, not after: requesting mic/
    // camera access shows this app's own permission screen first, then the
    // OS/browser's native prompt -- both require a real human tap, which on
    // literally every first call from a fresh browser/device takes at least
    // a few hundred ms, often much longer. With the emit gated behind
    // `await acquireLocalMedia()`, the server never heard the call was
    // accepted until that prompt was answered, so the CALLER'S screen sat
    // stuck on "Ringing..." indefinitely the entire time -- while this
    // side's own UI had already (wrongly) switched to a live, ticking
    // "Connected" timer via the setStatus('connected') two lines up,
    // completely independent of whether the server, or the other party,
    // knew anything had been accepted yet. Matches real phone UX: tapping
    // Accept connects the call signaling-wise immediately; audio/video
    // streams in as each side's media actually becomes ready.
    socket.emit('call_accept', { callId });
    await acquireLocalMedia();
    // Do NOT call setupPeerConnection() here. The server broadcasts
    // 'call_connected' back to both parties once this is received, and
    // this client's own handleConnected() (isIncoming === true) now
    // deliberately does nothing but wait -- the callee's
    // RTCPeerConnection is created lazily, exactly once, by the incoming
    // webrtc_offer handler when the caller's offer actually arrives. See
    // the comment on handleConnected above for why calling it from here
    // too used to create a second, competing RTCPeerConnection.
  };

  const handleDecline = () => {
    if (!socket || !callId) return;
    console.log('[Call] Call declined');
    setStatus('ended');
    socket.emit('call_reject', { callId, reason: 'declined' });
    cleanupCall();
    setTimeout(() => onEnd?.(), 500);
  };

  const handleEnd = () => {
    console.log('[Call] Ending call, callId:', callId);
    setStatus('ended');
    // callId can still be null here if the user hangs up during the brief
    // window before the server's call_ringing response arrives (outgoing
    // calls only). Cleanup and exiting the call screen must always work
    // regardless -- only the server notification is conditional on
    // actually having a callId to reference.
    if (socket && callId) {
      socket.emit('call_end', { callId });
    }
    cleanupCall();
    setTimeout(() => onEnd?.(), 500);
  };

  // The ICE connection has failed, or stayed 'disconnected' past the
  // recovery grace window -- this is a genuinely dead call, not a blip.
  // Show "Connection lost" for a moment, then reuse the exact same
  // hang-up path a normal "End Call" tap uses, rather than a separate
  // teardown routine.
  const handleConnectionLost = () => {
    setReconnecting(false);
    setConnectionLost(true);
    setTimeout(() => handleEnd(), 1500);
  };

  const cleanupCall = () => {
    console.log('[Call] Cleaning up: stopping local tracks, closing peer connection');
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('[Call] Local track stopped:', track.kind);
      });
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    remoteDescSetRef.current = false;
    pendingCandidatesRef.current = [];
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  };

  // Toggle Mic / Cam -- the button's own on/off visual used to be driven
  // entirely by the real track's .enabled (`setMicOn(track.enabled)`
  // inside the `if (track)` branch), so whenever localStreamRef had no
  // stream/track yet -- media still acquiring, acquireLocalMedia silently
  // failed, or (before the call_accept ordering fix above) the callee's
  // media was still gated behind an unanswered permission prompt -- both
  // early `return`s fired and NOTHING happened: no mute, no button change,
  // no console output, nothing to tell the user the tap did nothing. Now
  // the UI state (and the relay to the other party) always updates to
  // reflect what the user actually asked for; the real track is muted
  // too whenever one exists, but the button is never just dead.
  const toggleMic = () => {
    const nextOn = !micOn;
    setMicOn(nextOn);
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = nextOn;
    } else {
      console.warn('[Call] toggleMic: no local audio track yet -- UI updated, nothing to actually mute');
    }
    console.log('[Call] Local mic', nextOn ? 'unmuted' : 'muted');
    // Let the other party's UI reflect this instead of just going silent
    // with no explanation -- see call_mute_state relay in server/socket/calls.js.
    socket?.emit('call_mute_state', { to: toUserId, muted: !nextOn });
  };

  const toggleCam = () => {
    const nextOn = !camOn;
    setCamOn(nextOn);
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) {
      track.enabled = nextOn;
    } else {
      console.warn('[Call] toggleCam: no local video track yet -- UI updated, nothing to actually toggle');
    }
    console.log('[Call] Local camera', nextOn ? 'on' : 'off');
  };

  // Speaker on/off -- routes the remote media element's audio output via
  // the Audio Output Devices API (setSinkId). This is a real device
  // switch, not just a UI toggle, but it's inherently best-effort: it
  // only works where the browser supports setSinkId (desktop Chrome/Edge,
  // Android Chrome-based WebViews) and only where the platform actually
  // exposes multiple labeled audiooutput devices to pick between. Notably
  // NOT supported on iOS Safari/WKWebView (which Capacitor's iOS builds
  // use) -- there is no web API to force earpiece-vs-speaker routing
  // there; that requires a native Capacitor plugin, which is not
  // currently installed in this project (see summary).
  const toggleSpeaker = async () => {
    const next = !speakerOn;
    setSpeakerOn(next);

    const mediaEl = type === 'video' ? remoteVideoRef.current : remoteAudioRef.current;
    if (!mediaEl || typeof mediaEl.setSinkId !== 'function') {
      console.log('[Call] Speaker toggle: setSinkId unsupported on this platform, UI-only');
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      const speakerDevice = outputs.find(d => /speaker/i.test(d.label));
      const sinkId = next ? (speakerDevice?.deviceId || 'default') : 'default';
      await mediaEl.setSinkId(sinkId);
      console.log('[Call] Audio output sink set to:', sinkId, next ? '(speaker)' : '(default/earpiece)');
    } catch (err) {
      console.error('[Call] Failed to switch audio output device:', err);
    }
  };

  const formatTime = (s) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  const cleanUsername = partnerUsername 
    ? (partnerUsername.startsWith('@') ? partnerUsername : `@${partnerUsername}`)
    : (partnerName ? `@${partnerName.toLowerCase().replace(/\s+/g, '')}` : '');

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-zinc-950/95 backdrop-blur-md select-none">
      {/* Always mounted so audio-only calls (which render no <video> at
          all below) have somewhere to actually play the remote stream --
          see pc.ontrack. Hidden regardless of call type since video calls
          play remote audio through the visible <video> element instead.
          Uses sr-only (clip/1px, not display:none) deliberately -- some
          mobile browsers deprioritize or suspend playback on media
          elements with display:none, even with autoplay/playsinline set,
          since the element is treated as fully removed from rendering. */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="sr-only pointer-events-none" />

      {/* ── VIDEO CALL LAYOUT ──────────────────────────────────────── */}
      {type === 'video' ? (
        <div className="relative w-full h-full flex flex-col justify-between overflow-hidden">
          {/* Video Streams */}
          {status === 'connected' && (
            <div className="absolute inset-0 w-full h-full bg-black flex items-center justify-center overflow-hidden">
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
              <div className="absolute top-20 right-6 w-28 h-40 rounded-2xl overflow-hidden border-2 border-white/80 shadow-2xl bg-zinc-900 z-30">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
          )}

          {/* Top Center Header: Pet Name & @Username */}
          <div className="relative z-20 pt-12 text-center px-6 space-y-1 bg-gradient-to-b from-black/80 via-black/40 to-transparent pb-10">
            <h2 className="text-2xl font-black tracking-tight text-white drop-shadow-md">{partnerName}</h2>
            {cleanUsername && (
              <p className="text-xs font-bold text-pink-300 drop-shadow-sm">{cleanUsername}</p>
            )}
            <p className={`text-xs font-bold tracking-widest uppercase pt-1 ${
              permissionDenied ? 'text-rose-400' :
              connectionLost ? 'text-rose-400' :
              reconnecting ? 'text-amber-400 animate-pulse' :
              status === 'ringing' || status === 'dialing' ? 'text-white/80 animate-pulse' :
              status === 'connected' ? 'text-emerald-400 font-bold' :
              'text-rose-400'
            }`}>
              {permissionDenied ? `${permissionDenied === 'camera' ? 'Camera' : 'Microphone'} access denied` :
               connectionLost ? 'Connection lost' :
               reconnecting ? 'Reconnecting...' :
               status === 'dialing' ? 'Connecting...' :
               status === 'ringing' ? 'Ringing...' :
               status === 'connected' ? formatTime(duration) :
               'Call ended'}
            </p>
            {status === 'connected' && remoteMuted && (
              <span className="inline-flex items-center gap-1 mt-1 bg-zinc-900/70 text-white/90 text-[10px] font-bold px-2.5 py-1 rounded-full">
                <span className="material-symbols-outlined text-xs">mic_off</span> {partnerName} is muted
              </span>
            )}
          </div>

          {/* Bottom Call Controls Bar */}
          <div className="relative z-20 pb-12 pt-6 px-6 bg-gradient-to-t from-black/85 via-black/45 to-transparent flex flex-col items-center gap-4">
            {status === 'ringing' && isIncoming ? (
              <div className="flex gap-8 justify-center w-full">
                <button
                  onClick={handleDecline}
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white bg-rose-500 hover:bg-rose-600 shadow-lg active:scale-90 transition-transform"
                  title="Decline"
                >
                  <span className="material-symbols-outlined text-[28px]">call_end</span>
                </button>
                <button
                  onClick={handleAccept}
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white bg-emerald-500 hover:bg-emerald-600 shadow-[0_0_20px_rgba(16,185,129,0.4)] active:scale-90 transition-transform"
                  title="Accept"
                >
                  <span className="material-symbols-outlined text-[28px]">call</span>
                </button>
              </div>
            ) : (
              /* Video Call Controls: Camera, Speaker, Mute/Unmute, End Call */
              <div className="flex items-center justify-center gap-5 w-full">
                {/* 🎥 Camera On / Off */}
                <button
                  onClick={toggleCam}
                  className={`w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90 shadow-lg ${
                    camOn ? 'bg-white/20 hover:bg-white/30 backdrop-blur-md border border-white/10' : 'bg-rose-500 hover:bg-rose-600'
                  }`}
                  title={camOn ? 'Camera Off' : 'Camera On'}
                >
                  <span className="material-symbols-outlined text-[24px]">{camOn ? 'videocam' : 'videocam_off'}</span>
                </button>

                {/* 🔊 Speaker */}
                <button
                  onClick={toggleSpeaker}
                  className={`w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90 shadow-lg ${
                    speakerOn ? 'bg-white/20 hover:bg-white/30 backdrop-blur-md border border-white/10 text-emerald-300' : 'bg-zinc-800/80 text-zinc-400'
                  }`}
                  title={speakerOn ? 'Speaker On' : 'Speaker Off'}
                >
                  <span className="material-symbols-outlined text-[24px]">{speakerOn ? 'volume_up' : 'volume_off'}</span>
                </button>

                {/* 🎤 Mute / Unmute */}
                <button
                  onClick={toggleMic}
                  className={`w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90 shadow-lg ${
                    micOn ? 'bg-white/20 hover:bg-white/30 backdrop-blur-md border border-white/10' : 'bg-rose-500 hover:bg-rose-600'
                  }`}
                  title={micOn ? 'Mute' : 'Unmute'}
                >
                  <span className="material-symbols-outlined text-[24px]">{micOn ? 'mic' : 'mic_off'}</span>
                </button>

                {/* 📞 End Call */}
                <button
                  onClick={handleEnd}
                  className="w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90 bg-rose-500 hover:bg-rose-600 shadow-[0_4px_20px_rgba(244,63,94,0.4)]"
                  title="End Call"
                >
                  <span className="material-symbols-outlined text-[24px]">call_end</span>
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── AUDIO CALL LAYOUT ──────────────────────────────────────── */
        <div className="flex flex-col items-center justify-between p-8 text-white text-center z-10 w-full max-w-sm h-[85vh]">
          {/* User Card */}
          <div className="flex flex-col items-center gap-5 mt-6">
            <div className="relative">
              <img
                src={partnerAvatar || publicAsset('/logo.png')}
                alt={partnerName}
                className="w-32 h-32 rounded-full object-cover border-4 border-pink-400/40 z-10 relative shadow-2xl"
              />
              {(status === 'ringing' || status === 'dialing') && (
                <div className="absolute -inset-4 rounded-full border-2 border-pink-400/40 animate-[ping_1.5s_ease-in-out_infinite]" />
              )}
              {reconnecting && (
                <div className="absolute -inset-4 rounded-full border-2 border-amber-400/50 animate-[ping_1.5s_ease-in-out_infinite]" />
              )}
              {status === 'connected' && !reconnecting && !connectionLost && (
                <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center border-2 border-zinc-900 z-20">
                  <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                </div>
              )}
              {reconnecting && (
                <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center border-2 border-zinc-900 z-20 animate-spin">
                  <span className="material-symbols-outlined text-white text-sm">sync</span>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <h2 className="text-2xl font-black tracking-tight text-white">{partnerName}</h2>
              {cleanUsername && (
                <p className="text-xs font-bold text-pink-300">{cleanUsername}</p>
              )}
              <p className={`text-xs font-bold tracking-widest uppercase pt-1 ${
                permissionDenied ? 'text-rose-400' :
                connectionLost ? 'text-rose-400' :
                reconnecting ? 'text-amber-400 animate-pulse' :
                status === 'ringing' || status === 'dialing' ? 'text-white/70 animate-pulse' :
                status === 'connected' ? 'text-emerald-400 font-bold' :
                'text-rose-400'
              }`}>
                {permissionDenied ? `${permissionDenied === 'camera' ? 'Camera' : 'Microphone'} access denied` :
                 connectionLost ? 'Connection lost' :
                 reconnecting ? 'Reconnecting...' :
                 status === 'dialing' ? 'Connecting...' :
                 status === 'ringing' ? 'Ringing...' :
                 status === 'connected' ? formatTime(duration) :
                 'Call ended'}
              </p>
              {status === 'connected' && remoteMuted && (
                <span className="inline-flex items-center gap-1 mt-1 bg-zinc-900/70 text-white/90 text-[10px] font-bold px-2.5 py-1 rounded-full">
                  <span className="material-symbols-outlined text-xs">mic_off</span> {partnerName} is muted
                </span>
              )}
            </div>
          </div>

          {/* Essential Audio Controls Bar */}
          <div className="flex flex-col gap-6 items-center w-full mb-4">
            {status === 'ringing' && isIncoming ? (
              <div className="flex gap-8 justify-center w-full">
                <button
                  onClick={handleDecline}
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white bg-rose-500 hover:bg-rose-600 shadow-lg active:scale-90 transition-transform"
                  title="Decline"
                >
                  <span className="material-symbols-outlined text-[28px]">call_end</span>
                </button>
                <button
                  onClick={handleAccept}
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white bg-emerald-500 hover:bg-emerald-600 shadow-[0_0_20px_rgba(16,185,129,0.4)] active:scale-90 transition-transform"
                  title="Accept"
                >
                  <span className="material-symbols-outlined text-[28px]">call</span>
                </button>
              </div>
            ) : (
              /* Audio Call Essential Controls: Speaker, Mute/Unmute, End Call */
              <div className="flex items-center justify-center gap-6 w-full">
                {/* 🔊 Speaker */}
                <button
                  onClick={toggleSpeaker}
                  className={`w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90 shadow-lg ${
                    speakerOn ? 'bg-white/20 hover:bg-white/30 backdrop-blur-md border border-white/10 text-emerald-300' : 'bg-zinc-800/80 text-zinc-400'
                  }`}
                  title={speakerOn ? 'Speaker On' : 'Speaker Off'}
                >
                  <span className="material-symbols-outlined text-[24px]">{speakerOn ? 'volume_up' : 'volume_off'}</span>
                </button>

                {/* 🎤 Mute / Unmute */}
                <button
                  onClick={toggleMic}
                  className={`w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90 shadow-lg ${
                    micOn ? 'bg-white/20 hover:bg-white/30 backdrop-blur-md border border-white/10' : 'bg-rose-500 hover:bg-rose-600'
                  }`}
                  title={micOn ? 'Mute' : 'Unmute'}
                >
                  <span className="material-symbols-outlined text-[24px]">{micOn ? 'mic' : 'mic_off'}</span>
                </button>

                {/* 📞 End Call */}
                <button
                  onClick={handleEnd}
                  className="w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90 bg-rose-500 hover:bg-rose-600 shadow-[0_4px_20px_rgba(244,63,94,0.4)]"
                  title="End Call"
                >
                  <span className="material-symbols-outlined text-[24px]">call_end</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
