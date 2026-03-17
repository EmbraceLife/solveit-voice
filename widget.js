// ═══════════════════════════════════════════════════════════════════════
// SolveIt Voice — Main Widget (widget.js)
//
// DESIGN: Creates the voice widget DOM, SpeechRecognition engine,
// beep sounds, silence timer, wake word detection, and the shared
// V = window._voice bridge that all other modules attach to.
//
// This is the foundation — loaded FIRST by content.js.
// All other modules (state-machine, send, tts, kokoro, porcupine,
// draggable, visibility) read from and write to window._voice.
//
// INIT GUARD: window.__voiceWidgetInit prevents duplicate initialization
// if content.js re-runs (e.g. on SPA navigation within SolveIt).
// ═══════════════════════════════════════════════════════════════════════

if (!window.__voiceWidgetInit) {
window.__voiceWidgetInit = true;

(function() {
// --- Cleanup previous instance ---
if (window._voiceCleanup) window._voiceCleanup();
document.getElementById('voice-widget')?.remove();

// --- AbortController for document-level listeners ---
// DESIGN: All document-level listeners use this controller.
// ac.abort() removes them all at once during cleanup.
const ac = new AbortController();
const sig = { signal: ac.signal };

// --- Constants ---
// getDname() reads the current dialog name from the page at call-time.
// DESIGN: Dynamic getter — if dialog name changes mid-session, this
// always returns the current name (unlike a hardcoded value).
const getDname = () => document.documentElement.dataset.solveitDname || '';
const DEBUG = true;
const log = (...args) => { if (DEBUG) console.log('[Voice]', ...args); };
const CFG = {
    silenceMs: 8000,       // ms of silence before sending command
    watchdogMs: 2000,      // ms between watchdog checks
    restartMs: 300,        // default restart delay
    retryMs: 1000,         // retry delay on start failure
    postSendMs: 1500,      // restart delay after sending transcript
    beepFreq: 880,         // wake beep frequency
    beepDur: 200,          // wake beep duration ms
    confirmFreq: 660,      // send confirmation beep frequency
    confirmDur: 150,       // send confirmation beep duration ms
    ttsRate: 1.0,          // TTS speech rate
    ttsVoice: 'Google UK English Male',
};
// CLR — Color palette for status bar states
const CLR = { ok: '#6bff6b', info: '#6bc5ff', warn: '#ffd93d', err: '#ff6b6b', muted: '#aaa' };
const MSG = {
    idle: 'Click mic to start',
    wake: '👂 Listening for "Solveit"...',
    listening: '🟢 Listening...',
    command: '🟢 Speak your command...',
    noSpeech: 'No speech detected',
    micDenied: '❌ Mic permission denied',
    noApi: '❌ Speech API not supported',
};

// --- DOM helper ---
function el(tag, cls, props) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (props) Object.assign(e, props);
    return e;
}

// --- Widget Container ---
const div = el('div', null, { id: 'voice-widget' });
const btn = el('button', 'v-mic', { textContent: '🎤' });
btn.style.display = 'none';
const status = el('span', 'v-status');

function setStatus(text, color = CLR.muted) { status.textContent = text; status.style.color = color; }
setStatus(MSG.idle);

const ttsStopBtn = el('button', 'v-tts-stop', { textContent: '⏹', title: 'Stop speech' });
ttsStopBtn.style.display = 'none';

// --- Hidden checkbox state holders (lightweight state objects) ---
// DESIGN: Each toggle in the gear dropdown uses { checked: bool } objects
// instead of real HTML checkboxes. makeSwitch() reads/writes .checked
// and calls .onchange() when the user clicks the toggle.
const autoCb = { checked: false };       // Auto-run OFF by default
const toggleCb = { checked: true };      // Continuous ON by default
const ttsCb = { checked: true };         // TTS voice ON by default
const ttsManualCb = { checked: true };   // TTS manual ON by default
const anchorCb = { checked: false };     // Select anchor OFF by default
const porcupineCb = { checked: false };  // Porcupine wake word OFF by default
let anchorId = null;

// --- Message Type Toggle ---
// DESIGN: Cycles through prompt/code/note on click. Only prompts auto-run.
const MSG_TYPES = [
    { type: 'prompt', color: '#e74c3c', label: 'Prompt' },
    { type: 'code',   color: '#4a90e2', label: 'Code' },
    { type: 'note',   color: '#2ecc71', label: 'Note' }
];
let msgType = 'prompt';

// --- Expose shared state under single namespace ---
const V = window._voice = { ttsStopBtn, ttsCb, ttsManualCb, toggleCb, speaking: false, log, CFG, CLR };
V.ttsEnd = () => {
    if (V._ttsSafety) { clearTimeout(V._ttsSafety); V._ttsSafety = null; }
    speechSynthesis.cancel();
    V.speaking = false;
    ttsStopBtn.style.display = 'none';
    if (toggleCb.checked && !wakeDetected) safeStartRec(CFG.restartMs);
};
ttsStopBtn.onclick = V.ttsEnd;

// --- Toggle switch helper ---
function makeSwitch(label, stateObj) {
    const row = el('div', 'v-switch-row');
    const txt = el('span', null, { textContent: label });
    const track = el('span', 'v-track');
    const thumb = el('span', 'v-thumb');

    function render() {
        if (stateObj.checked) {
            track.style.background = '#6bff6b';
            thumb.style.right = '1px'; thumb.style.left = 'auto'; thumb.style.background = '#fff';
        } else {
            track.style.background = '#555';
            thumb.style.left = '1px'; thumb.style.right = 'auto'; thumb.style.background = '#888';
        }
    }
    render();
    track.appendChild(thumb);
    row.appendChild(txt);
    row.appendChild(track);
    row.onclick = () => { stateObj.checked = !stateObj.checked; render(); if (stateObj.onchange) stateObj.onchange(); };
    return { row, render };
}

// --- Gear Button & Dropdown ---
function setGearStyle(open) {
    gearBtn.style.background = open ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
    gearBtn.style.color = open ? '#fff' : '#aaa';
}
const gearBtn = el('button', 'v-gear', { textContent: '⚙️', title: 'Settings' });
gearBtn.onmouseenter = () => setGearStyle(true);
gearBtn.onmouseleave = () => { if (!ddOpen) setGearStyle(false); };
const dropdown = el('div', 'v-dropdown');

const autoSwitch = makeSwitch('Auto-run code', autoCb);
const contSwitch = makeSwitch('Continuous mode', toggleCb);
const ttsSwitch = makeSwitch('TTS voice prompt', ttsCb);
const ttsManualSwitch = makeSwitch('TTS manual prompt', ttsManualCb);
const anchorSwitch = makeSwitch('Select anchor', anchorCb);
const anchorLabel = el('div', 'v-anchor-label');
anchorLabel.textContent = '📌 (none — using end)';
const porcupineSwitch = makeSwitch('🦔 Porcupine wake', porcupineCb);

dropdown.appendChild(autoSwitch.row);
dropdown.appendChild(contSwitch.row);
dropdown.appendChild(ttsSwitch.row);
dropdown.appendChild(ttsManualSwitch.row);
dropdown.appendChild(anchorSwitch.row);
dropdown.appendChild(anchorLabel);
dropdown.appendChild(porcupineSwitch.row);

// --- Porcupine toggle handler ---
// DESIGN: Only subscribe/unsubscribe when continuous mode is ON.
// Without continuous, there's no Google SpeechRecognition to capture
// the command after Porcupine detects the wake word.
porcupineCb.onchange = () => {
    if (!toggleCb.checked) return;
    if (porcupineCb.checked) {
        if (V.porcupineSubscribe) V.porcupineSubscribe();
        setStatus('🦔 Say "solvent"', CLR.info);
    } else {
        if (V.porcupineUnsubscribe) V.porcupineUnsubscribe();
        setStatus(MSG.wake, CLR.info);
    }
};

// --- Message Type Dot ---
const msgTypeDot = el('button', 'v-gear', { title: 'Message type' });
msgTypeDot.style.cssText = 'width:20px;height:20px;border-radius:50%;padding:0;margin-right:4px;border:2px solid rgba(255,255,255,0.3)';
const setMsgTypeDot = (t) => { msgType = t; msgTypeDot.style.background = MSG_TYPES.find(m => m.type === t).color; };
setMsgTypeDot('prompt');
msgTypeDot.onclick = () => {
    const idx = MSG_TYPES.findIndex(m => m.type === msgType);
    const next = MSG_TYPES[(idx + 1) % MSG_TYPES.length];
    setMsgTypeDot(next.type);
    setStatus('Message type: ' + next.label, next.color);
};

let ddOpen = false;
gearBtn.onclick = (e) => { e.stopPropagation(); ddOpen = !ddOpen; dropdown.style.display = ddOpen ? 'block' : 'none'; setGearStyle(ddOpen); };
document.addEventListener('click', (e) => {
    if (ddOpen && !dropdown.contains(e.target) && e.target !== gearBtn) {
        ddOpen = false; dropdown.style.display = 'none'; setGearStyle(false);
    }
}, sig);

// --- Anchor Selection ---
// DESIGN: One-shot mode — toggle ON, click a message, auto-OFF.
// Uses [data-sm] to find Solveit's message wrapper (framework-independent).
anchorCb.onchange = () => {
    if (anchorCb.checked) setStatus('📌 Click a message to set anchor...', CLR.warn);
    else setStatus(toggleCb.checked ? (porcupineCb.checked ? '🦔 Say "solvent"' : MSG.wake) : MSG.idle);
};

document.addEventListener('click', (e) => {
    if (!anchorCb.checked) return;
    const wrapper = e.target.closest('[data-sm]');
    if (!wrapper) return;
    const msgId = wrapper.id;
    if (!msgId) return;
    anchorId = msgId;
    anchorLabel.textContent = '📌 ' + anchorId;
    anchorCb.checked = false;
    anchorSwitch.render();
    setStatus('📌 Anchor set: ' + anchorId, CLR.ok);
    log('Anchor set:', anchorId);
}, sig);

const gearWrap = el('div', 'v-gear-wrap');
gearWrap.appendChild(gearBtn);
gearWrap.appendChild(dropdown);

// --- Assemble Widget ---
div.appendChild(btn);
div.appendChild(ttsStopBtn);
div.appendChild(status);
div.appendChild(msgTypeDot);
div.appendChild(gearWrap);
document.body.appendChild(div);

// --- Expose widget element and shared functions ---
V.widget = div;
V.setStatus = setStatus;
V.getDname = getDname;
V.resetUI = resetUI;
V.autoCb = autoCb;
V.doubleBeep = doubleBeep;

// --- Speech Recognition Setup ---
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
    status.textContent = MSG.noApi;
    window._voiceCleanup = () => { ac.abort(); div.remove(); };
    return;
}

const rec = new SR();
V.rec = rec;
V.safeStart = safeStartRec;
rec.continuous = true;
rec.interimResults = true;

let on = false;
let transcript = '';
let silenceTimer = null;
let wakeDetected = false;
let commandTranscript = '';
let commandBuffer = '';
let sessionText = '';
let wakeResultIdx = 0;
let lastResultLen = 0;
let lastResultTime = 0;
let emptyTextSince = 0;
let livenessWarned = false;
let destroyed = false;
let startTimer = null;
let userActive = false;

// --- Getters for split-out modules ---
Object.defineProperty(V, 'msgType',    { get: () => msgType,    configurable: true });
Object.defineProperty(V, 'anchorId',   { get: () => anchorId,   configurable: true });
Object.defineProperty(V, 'destroyed',  { get: () => destroyed,  configurable: true });
Object.defineProperty(V, 'userActive', { get: () => userActive, configurable: true });

// --- Robust restart function ---
function canStart() { return !(destroyed || on); }
function safeStartRec(delay = 300) {
    if (startTimer) clearTimeout(startTimer);
    startTimer = setTimeout(() => {
        startTimer = null;
        if (!canStart()) return;
        if (V._tabHidden) return;
        if (!toggleCb.checked && !wakeDetected) return;
        try { rec.start(); log('rec.start() OK'); }
        catch(e) {
            log('rec.start() failed:', e.message, '— retrying in 1s');
            startTimer = setTimeout(() => {
                startTimer = null;
                if (!canStart()) return;
                try { rec.start(); } catch(e2) { log('rec.start() retry failed:', e2.message); }
            }, CFG.retryMs);
        }
    }, delay);
}

// --- Watchdog: recover stuck TTS and frozen sessions ---
const watchdog = setInterval(() => {
    if (destroyed) { clearInterval(watchdog); return; }
    if (V.speaking && !speechSynthesis.speaking && !speechSynthesis.pending) {
        log('Watchdog: TTS stuck, forcing reset'); V.ttsEnd();
    }
    // Liveness check: detect frozen speech session
    if (wakeDetected && on) {
        const hasText = !!(sessionText.trim() || commandBuffer.trim());
        if (hasText) { emptyTextSince = 0; }
        else if (!emptyTextSince) { emptyTextSince = Date.now(); }
        const emptyMs = emptyTextSince ? Date.now() - emptyTextSince : 0;
        log('Liveness:', { emptyMs: Math.round(emptyMs), hasText, sessionText: sessionText.slice(-30), commandBuffer: commandBuffer.slice(-30) });
        if (emptyTextSince && emptyMs > 2000 && !livenessWarned) {
            log('Watchdog: empty for 2s, warning beep'); livenessWarned = true; warnBeep();
        }
        if (emptyTextSince && emptyMs > 5000) {
            log('Watchdog: frozen session detected, restarting');
            if (V.go) V.go('command', 'liveness restart — session frozen');
            lastResultTime = 0; emptyTextSince = 0; livenessWarned = false;
            commandBuffer = ''; sessionText = '';
            resetSilenceTimer(); stopRec(); beep(); safeStartRec(CFG.restartMs);
        }
    }
    if (toggleCb.checked && !on && !V._tabHidden) { log('Watchdog: restarting'); safeStartRec(100); }
}, CFG.watchdogMs);

// --- AudioContext for beeps ---
let audioCtx = null;
async function beep(freq = 880, duration = 150) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = freq; gain.gain.value = 0.3;
    osc.start(); osc.stop(audioCtx.currentTime + duration / 1000);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}
async function doubleBeep(freq = 550, dur = 100, gap = 130) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const o1 = audioCtx.createOscillator(), g1 = audioCtx.createGain();
    o1.connect(g1); g1.connect(audioCtx.destination); o1.frequency.value = freq; g1.gain.value = 0.3;
    o1.start(); o1.stop(audioCtx.currentTime + dur/1000);
    const o2 = audioCtx.createOscillator(), g2 = audioCtx.createGain();
    o2.connect(g2); g2.connect(audioCtx.destination); o2.frequency.value = freq; g2.gain.value = 0.3;
    o2.start(audioCtx.currentTime + gap/1000); o2.stop(audioCtx.currentTime + gap/1000 + dur/1000);
    o2.onended = () => { o1.disconnect(); g1.disconnect(); o2.disconnect(); g2.disconnect(); };
}
async function warnBeep() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const o1 = audioCtx.createOscillator(), g1 = audioCtx.createGain();
    o1.connect(g1); g1.connect(audioCtx.destination); o1.frequency.value = 880; g1.gain.value = 0.3;
    o1.start(); o1.stop(audioCtx.currentTime + 0.15);
    const o2 = audioCtx.createOscillator(), g2 = audioCtx.createGain();
    o2.connect(g2); g2.connect(audioCtx.destination); o2.frequency.value = 440; g2.gain.value = 0.3;
    o2.start(audioCtx.currentTime + 0.18); o2.stop(audioCtx.currentTime + 0.33);
    o2.onended = () => { o1.disconnect(); g1.disconnect(); o2.disconnect(); g2.disconnect(); };
}

// --- Silence timer ---
function clearSilence() { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } }
function resetWakeState() {
    wakeDetected = false; commandTranscript = ''; commandBuffer = '';
    sessionText = ''; wakeResultIdx = 0; clearSilence(); emptyTextSince = 0;
}
V.resetWakeState = resetWakeState;
V.isWakeActive = () => wakeDetected;

// --- Debug dashboard ---
let ttsPoll = null;
let ttsSafety = null;
Object.defineProperty(V, '_dbg', { get: () => ({
    commandTranscript, commandBuffer, sessionText, wakeResultIdx,
    wakeDetected, state: V.state, on, lastResultLen, ttsPoll, ttsSafety,
    destroyed, silenceTimer, wakeDetected, anchorId
}), configurable: true });
V._resetSilenceTimer = () => resetSilenceTimer();
V._collectTranscript = (results, start) => collectTranscript(results, start);

// --- TTS watcher (used by tts.js but defined here for shared access) ---
function clearTtsWatch() {
    if (ttsPoll) { clearInterval(ttsPoll); ttsPoll = null; }
    if (ttsSafety) { clearTimeout(ttsSafety); ttsSafety = null; }
}
V.clearTtsWatch = clearTtsWatch;
// Expose ttsPoll/ttsSafety setters for tts.js
V._setTtsPoll = (v) => { ttsPoll = v; };
V._setTtsSafety = (v) => { ttsSafety = v; };
V._getTtsPoll = () => ttsPoll;

// --- Barge-in: Porcupine trigger ---
V.triggerWake = () => {
    if (!porcupineCb.checked) return;
    if (wakeDetected || V.state === 'send') return;
    userActive = true;
    log('Porcupine: wake word triggered!');
    wakeDetected = true;
    if (V.go) V.go('command', V.speaking ? 'Porcupine barge-in — interrupted TTS' : ttsPoll ? 'Porcupine barge-in — interrupted generating response' : 'Porcupine wake word detected');
    wakeResultIdx = lastResultLen;
    if (V.speaking) {
        log('Porcupine barge-in: stopping TTS');
        speechSynthesis.cancel(); V.speaking = false; ttsStopBtn.style.display = 'none';
        const kokoroAudio = document.querySelector('#kokoro-audio-container audio');
        if (kokoroAudio && !kokoroAudio.paused) kokoroAudio.pause();
    }
    clearTtsWatch(); if (V.clearKokoroWatch) V.clearKokoroWatch();
    beep(CFG.beepFreq, CFG.beepDur);
    commandTranscript = ''; commandBuffer = ''; sessionText = '';
    setStatus(MSG.command, CLR.ok);
    if (!on) safeStartRec(100);
    resetSilenceTimer();
};
V.porcupineCb = porcupineCb;

function stopRec() { try { rec.stop(); } catch(e) {} }
function resetUI() { btn.textContent = '🎤'; setStatus(MSG.idle); }
function collectTranscript(results, start = 0) {
    let text = '';
    for (let i = start; i < results.length; i++) text += results[i][0].transcript;
    return text;
}

function resetSilenceTimer() {
    clearSilence();
    silenceTimer = setTimeout(async () => {
        silenceTimer = null;
        if (wakeDetected && commandTranscript.trim()) {
            V.go('send', 'silence timer fired');
            const text = commandTranscript.trim();
            resetWakeState(); stopRec(); doubleBeep();
            await V.sendAndRestart(text);
        }
    }, CFG.silenceMs);
}

// --- Wake phrase detection ---
const WAKE_RE = /(?:solveit|solve it|solvent|so late|salt wait)/gi;
function findWake(text) {
    let last = null;
    for (const m of text.matchAll(WAKE_RE)) last = m;
    return last ? { idx: last.index, len: last[0].length } : null;
}

// --- Button click handler ---
btn.onclick = async () => {
    userActive = true;
    if (on) {
        stopRec(); resetWakeState();
        if (!toggleCb.checked && transcript.trim()) {
            const text = transcript; transcript = '';
            V.go('send', 'manual mic stop with text');
            await V.sendAndRestart(text);
        } else { resetUI(); V.go('idle', 'manual mic stop, no text'); }
    } else {
        if (V.speaking) {
            log('Barge-in: mic clicked, stopping TTS');
            speechSynthesis.cancel(); V.speaking = false; ttsStopBtn.style.display = 'none';
            const kokoroAudio = document.querySelector('#kokoro-audio-container audio');
            if (kokoroAudio && !kokoroAudio.paused) kokoroAudio.pause();
        }
        transcript = ''; resetWakeState();
        try { rec.start(); } catch(e) { setStatus('⚠️ ' + e.message, CLR.warn); }
        if (V.go) V.go('manual', !V.speaking && ttsPoll ? 'barge-in via mic click — interrupted generating response' : V.speaking ? 'barge-in via mic click — interrupted TTS' : 'mic button clicked');
    }
};

// --- Recognition events ---
rec.onstart = () => {
    on = true;
    if (wakeDetected) wakeResultIdx = 0;
    if (toggleCb.checked) {
        btn.style.display = 'none';
        if (!wakeDetected) setStatus(porcupineCb.checked ? '🦔 Say "solvent"' : MSG.wake, CLR.info);
    } else { btn.textContent = '⏹'; setStatus(MSG.listening, CLR.ok); }
};

rec.onend = async () => {
    on = false;
    if (destroyed) return;
    if (wakeDetected && sessionText.trim()) { commandBuffer = commandBuffer + sessionText.trim() + ' '; sessionText = ''; }
    if (V.state === 'send' || V.state === 'idle') return;
    if (toggleCb.checked) {
        if (!silenceTimer && !(porcupineCb.checked && wakeDetected)) resetWakeState();
        safeStartRec(CFG.restartMs); return;
    }
    if (!transcript.trim()) { resetUI(); setStatus(MSG.noSpeech); return; }
    const text = transcript; transcript = '';
    await V.sendAndRestart(text);
};

rec.onerror = (e) => {
    log('Speech recognition error:', e.error);
    if (e.error === 'not-allowed') setStatus(MSG.micDenied, CLR.err);
    else if (e.error !== 'no-speech' && e.error !== 'aborted') setStatus('⚠️ ' + e.error, CLR.warn);
};

rec.onresult = (e) => {
    lastResultTime = Date.now();
    lastResultLen = e.results.length;
    if (toggleCb.checked) {
        if (porcupineCb.checked) {
            if (wakeDetected) {
                sessionText = collectTranscript(e.results, wakeResultIdx ?? e.resultIndex).trim();
                commandTranscript = commandBuffer + sessionText;
                setStatus('🟢 ' + commandTranscript.slice(-40), CLR.ok);
                resetSilenceTimer();
            }
        } else if (!wakeDetected && V.state !== 'send') {
            const latest = collectTranscript(e.results, e.resultIndex);
            const wake = findWake(latest);
            if (wake) {
                userActive = true; wakeDetected = true; wakeResultIdx = e.resultIndex;
                V.go('command', V.speaking ? 'Google barge-in — interrupted TTS' : ttsPoll ? 'Google barge-in — interrupted generating response' : 'Google wake word detected');
                if (V.speaking) {
                    log('Wake word barge-in: stopping TTS');
                    speechSynthesis.cancel(); V.speaking = false; ttsStopBtn.style.display = 'none';
                    const kokoroAudio = document.querySelector('#kokoro-audio-container audio');
                    if (kokoroAudio && !kokoroAudio.paused) kokoroAudio.pause();
                }
                clearTtsWatch(); if (V.clearKokoroWatch) V.clearKokoroWatch();
                beep(CFG.beepFreq, CFG.beepDur);
                commandBuffer = '';
                sessionText = latest.slice(wake.idx + wake.len).trim();
                commandTranscript = commandBuffer + sessionText;
                setStatus(MSG.command, CLR.ok); resetSilenceTimer();
            }
        } else {
            const text = collectTranscript(e.results, wakeResultIdx);
            const wake = findWake(text);
            if (wake) { sessionText = text.slice(wake.idx + wake.len).trim(); }
            else { sessionText = text.trim(); }
            commandTranscript = commandBuffer + sessionText;
            setStatus('🟢 ' + commandTranscript.slice(-40), CLR.ok);
            resetSilenceTimer();
        }
    } else {
        transcript = collectTranscript(e.results);
        setStatus('🟢 ' + transcript.slice(-40), CLR.ok);
    }
};

// --- Continuous mode toggle ---
toggleCb.onchange = () => {
    resetWakeState();
    if (toggleCb.checked) {
        btn.style.display = 'none'; V.speaking = false;
        safeStartRec(100);
        setStatus(porcupineCb.checked ? '🦔 Say "solvent"' : MSG.wake, CLR.info);
        if (V.go) V.go('listen', 'continuous mode ON');
    } else {
        btn.style.display = ''; stopRec(); resetUI();
        if (V.go) V.go('idle', 'continuous mode OFF');
    }
};
toggleCb.onchange();

// --- TTS: Preload voices ---
speechSynthesis.getVoices();
speechSynthesis.onvoiceschanged = () => log('Voices loaded:', speechSynthesis.getVoices().length);

// --- Monkey-patch debounceScroll ---
// DESIGN: Prevent Solveit from auto-scrolling to voice widget's
// temporary code messages (e.g. Kokoro TTS self-deleting messages).
if (!window._origDebounceScroll && window.debounceScroll) {
    window._origDebounceScroll = window.debounceScroll;
    window.debounceScroll = function(el) {
        if (el && el.id && el.closest && el.closest('#voice-widget')) return;
        return window._origDebounceScroll?.call(this, el);
    };
}

// --- Global cleanup ---
window._voiceCleanup = () => {
    if (window._origDebounceScroll) {
        window.debounceScroll = window._origDebounceScroll;
        delete window._origDebounceScroll;
    }
    destroyed = true;
    ac.abort();
    if (startTimer) clearTimeout(startTimer);
    clearSilence(); clearInterval(watchdog); clearTtsWatch();
    speechSynthesis.cancel(); speechSynthesis.onvoiceschanged = null;
    stopRec();
    if (audioCtx) try { audioCtx.close(); audioCtx = null; } catch(e) {}
    // Chain module cleanups
    if (V._stateCleanup) V._stateCleanup();
    if (V._sendCleanup) V._sendCleanup();
    if (V._dragCleanup) V._dragCleanup();
    if (V._visCleanup) V._visCleanup();
    if (window._kokoroCleanup) window._kokoroCleanup();
    if (window._saveToggleCleanup) window._saveToggleCleanup();
    div.remove();
    window.__voiceWidgetInit = false;
    log('Voice widget cleaned up');
};

log('✅ Voice widget loaded');
})();

} // end init guard
