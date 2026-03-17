// ═══════════════════════════════════════════════════════════════════════
// Voice Widget Module: Kokoro TTS — The Premium Voice (via Replicate)
//
// DESIGN: Calls Replicate's Kokoro-82M model directly from the browser
// using the HTTP API. No Python backend needed — the Replicate API key
// is stored in chrome.storage and passed via data-* attribute.
//
// FLOW: Detect stable response → POST to Replicate → poll prediction
// → get audio URL → play in <audio> element.
//
// When Kokoro is ON, it intercepts speechSynthesis.speak() to block
// browser TTS, ensuring only one voice plays at a time.
// ═══════════════════════════════════════════════════════════════════════

if (!window.__voiceKokoroInit) {
window.__voiceKokoroInit = true;

(function() {
const V = window._voice;
if (!V) { console.error('[Kokoro] No voice widget'); return; }
if (window._kokoroCleanup) window._kokoroCleanup();

const log = V.log;
const kokoroCb = { checked: false };

// DESIGN: Read Replicate API key from data-* attribute set by content.js.
// Dynamic getter — key updates if user changes it in popup while page is open.
const getReplicateKey = () => document.documentElement.dataset.solveitReplicateKey || '';

const KOKORO_VERSION = 'jaaari/kokoro-82m:f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13';

// --- Audio Container DOM ---
const ac = document.createElement('div');
ac.id = 'kokoro-audio-container';
const statusRow = document.createElement('div');
statusRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:2px 0';
const statusText = document.createElement('span');
statusText.className = 'kokoro-status';
const closeBtn = document.createElement('button');
closeBtn.textContent = '✕';
closeBtn.className = 'kokoro-close';
statusRow.appendChild(statusText);
statusRow.appendChild(closeBtn);
ac.appendChild(statusRow);

const audio = document.createElement('audio');
audio.controls = true;
audio.style.cssText = 'width:100%;height:48px;border-radius:8px';
ac.appendChild(audio);
document.body.appendChild(ac);

function resetAudio() {
    audio.pause(); audio.removeAttribute('src'); audio.load();
    ac.style.display = 'none'; V.speaking = false;
    if (V.toggleCb.checked) V.safeStart(V.CFG.restartMs);
}
closeBtn.onclick = resetAudio;

audio.onplay = () => { V.speaking = true; };
audio.onended = () => {
    statusText.textContent = '✅ Done — click ▶ to replay';
    V.speaking = false;
    if (V.toggleCb.checked) V.safeStart(V.CFG.restartMs);
};

// --- Block browser TTS when Kokoro ON ---
const origSpeak = speechSynthesis.speak.bind(speechSynthesis);
speechSynthesis.speak = function(utt) {
    if (kokoroCb.checked) { log('Kokoro: blocking browser TTS'); V.ttsStopBtn.style.display = 'none'; return; }
    return origSpeak(utt);
};

const origTtsEnd = V.ttsEnd;
V.ttsEnd = () => {
    if (kokoroCb.checked && !audio.paused && !audio.ended) return;
    origTtsEnd();
};

// --- Replicate API: Create prediction and poll until done ---
async function replicatePredict(text, voice = 'bf_emma', speed = 1.0) {
    const apiKey = getReplicateKey();
    if (!apiKey) throw new Error('No Replicate API key — set it in extension popup');

    // DESIGN: Parse "owner/model:version" format to extract version hash
    const versionHash = KOKORO_VERSION.split(':')[1];

    // Step 1: Create prediction
    const createResp = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Prefer': 'wait'  // DESIGN: Server waits up to 60s for completion
        },
        body: JSON.stringify({
            version: versionHash,
            input: { text: text.slice(0, 10000), voice, speed }
        })
    });

    if (!createResp.ok) {
        const err = await createResp.text();
        throw new Error('Replicate API error: ' + createResp.status + ' ' + err);
    }

    let prediction = await createResp.json();

    // Step 2: Poll if not yet complete (Prefer:wait usually returns complete)
    let attempts = 0;
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && attempts < 60) {
        await new Promise(r => setTimeout(r, 1000));
        const pollResp = await fetch('https://api.replicate.com/v1/predictions/' + prediction.id, {
            headers: { 'Authorization': 'Bearer ' + apiKey }
        });
        prediction = await pollResp.json();
        attempts++;
    }

    if (prediction.status === 'failed') throw new Error('Kokoro prediction failed: ' + (prediction.error || 'unknown'));
    if (prediction.status !== 'succeeded') throw new Error('Kokoro prediction timed out');

    // DESIGN: Output is the audio URL (direct link to WAV/MP3 file)
    return prediction.output;
}

// --- Main speak function ---
async function kokoroSpeak(text) {
    if (!text || !text.trim()) return;
    if (V.isWakeActive && V.isWakeActive()) { log('Kokoro suppressed: wake active'); return; }
    if (V._tabHidden) { log('Kokoro suppressed: tab hidden'); return; }

    statusText.textContent = '⏳ Generating audio...';
    ac.style.display = 'block';
    V.speaking = true;
    if (V.resetWakeState) V.resetWakeState();

    try {
        const audioUrl = await replicatePredict(text);
        if (!audioUrl) throw new Error('No audio URL returned');
        log('Kokoro: audio ready', audioUrl);
        statusText.textContent = '🔊 Playing...';
        audio.src = audioUrl;
        audio.play().catch(e => { log('Kokoro play error:', e); statusText.textContent = '❌ Play failed'; });
    } catch(e) {
        log('Kokoro error:', e.message);
        statusText.textContent = '❌ ' + e.message;
        V.speaking = false;
    }
}

// --- Toggle in gear dropdown ---
const dd = document.querySelector('#voice-widget .v-dropdown');
if (dd) {
    const row = document.createElement('div'); row.className = 'v-switch-row';
    const txt = document.createElement('span'); txt.textContent = '🎵 Kokoro TTS';
    const track = document.createElement('span'); track.className = 'v-track';
    const thumb = document.createElement('span'); thumb.className = 'v-thumb';
    function render() {
        track.style.background = kokoroCb.checked ? '#ff9f43' : '#555';
        if (kokoroCb.checked) { thumb.style.right='1px'; thumb.style.left='auto'; thumb.style.background='#fff'; }
        else { thumb.style.left='1px'; thumb.style.right='auto'; thumb.style.background='#888'; }
    }
    render();
    track.appendChild(thumb); row.appendChild(txt); row.appendChild(track);
    row.onclick = () => {
        kokoroCb.checked = !kokoroCb.checked; render();
        if (!kokoroCb.checked) resetAudio();
        log('Kokoro:', kokoroCb.checked ? 'ON' : 'OFF');
    };
    dd.appendChild(row);
}

// --- Watch for prompt responses (same pattern as tts.js) ---
const skipTags = new Set(['PRE', 'CODE', 'DETAILS']);
function getText(proseEl) {
    // DESIGN: Reuse V._extractProseText if available from tts.js
    if (V._extractProseText) return V._extractProseText(proseEl);
    const tw = document.createTreeWalker(proseEl, NodeFilter.SHOW_TEXT, {
        acceptNode: n => {
            let p = n.parentElement;
            while (p && p !== proseEl) { if (skipTags.has(p.tagName) || p.classList.contains('cm-editor')) return NodeFilter.FILTER_REJECT; p = p.parentElement; }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    let t = ''; while (tw.nextNode()) t += tw.currentNode.textContent;
    return t.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 10000);
}

let poll = null, safety = null;
function clearWatch() { if (poll) clearInterval(poll); if (safety) clearTimeout(safety); poll = safety = null; }
V.clearKokoroWatch = clearWatch;

function watchResp(id) {
    clearWatch();
    let last = '', stable = 0, threshold = 12;
    poll = setInterval(() => {
        const el = document.querySelector('#' + id + '-o .prose');
        if (!el) return;
        if (threshold < 20 && el.querySelector('details')) threshold = 20;
        const t = getText(el);
        if (!t.length) return;
        if (t === last) { if (++stable >= threshold) { clearWatch(); kokoroSpeak(t); } }
        else { last = t; stable = 0; }
    }, 500);
    safety = setTimeout(clearWatch, 300000);
}

const wsListen = (e) => {
    if (!V.userActive) return;
    if (V._tabHidden) { log('Kokoro watcher blocked: tab hidden'); return; }
    if (!kokoroCb.checked) return;
    const html = e.detail.message;
    if (!html.includes('data-mtype="prompt"')) return;
    const isVoice = html.includes('🎤');
    if (isVoice && !V.ttsCb.checked) return;
    if (!isVoice && !V.ttsManualCb.checked) return;
    const m = html.match(/id="(_[a-f0-9]+)"/);
    if (!m) return;
    log('Kokoro: watching', m[1]);
    watchResp(m[1]);
};
document.body.addEventListener('htmx:wsAfterMessage', wsListen);

// --- Play button for selected completed prompts ---
const playBtn = document.createElement('button');
playBtn.textContent = '▶';
playBtn.title = 'Play audio for this response';
playBtn.style.cssText = 'display:none;font-size:1.2em;border:none;background:rgba(255,159,67,0.3);' +
  'border-radius:8px;padding:4px 10px;color:#ff9f43;cursor:pointer;margin-left:4px';
playBtn.onmouseenter = () => playBtn.style.background = 'rgba(255,159,67,0.5)';
playBtn.onmouseleave = () => playBtn.style.background = 'rgba(255,159,67,0.3)';

const widget = document.getElementById('voice-widget');
if (widget) {
    const statusEl = widget.querySelector('.v-status');
    if (statusEl) widget.insertBefore(playBtn, statusEl);
}

let selectedPromptId = null;

function checkSelectedPrompt() {
    const sel = document.querySelector('[data-sm="primary"]');
    if (!sel) { playBtn.style.display = 'none'; selectedPromptId = null; return; }
    const msgId = sel.id;
    const card = document.querySelector('#' + msgId + '-i');
    const mtype = card ? card.getAttribute('data-mtype') : sel.getAttribute('data-mtype');
    if (mtype !== 'prompt') { playBtn.style.display = 'none'; selectedPromptId = null; return; }
    const outputEl = document.querySelector('#' + msgId + '-o .prose');
    if (!outputEl || !getText(outputEl).trim()) { playBtn.style.display = 'none'; selectedPromptId = null; return; }
    selectedPromptId = msgId;
    playBtn.style.display = 'inline';
}

playBtn.onclick = () => {
    if (!selectedPromptId) return;
    const outputEl = document.querySelector('#' + selectedPromptId + '-o .prose');
    if (!outputEl) return;
    const text = getText(outputEl);
    if (!text.trim()) return;
    log('Play selected prompt:', selectedPromptId, text.length, 'chars');
    if (kokoroCb.checked) { kokoroSpeak(text); }
    else if (V._speakText) { V._speakText(text); }
};

const playObserver = new MutationObserver(checkSelectedPrompt);
playObserver.observe(document.body, { attributes: true, attributeFilter: ['data-sm'], subtree: true });

// --- Cleanup ---
window._kokoroCleanup = () => {
    speechSynthesis.speak = origSpeak;
    V.ttsEnd = origTtsEnd;
    document.body.removeEventListener('htmx:wsAfterMessage', wsListen);
    playObserver.disconnect();
    clearWatch(); resetAudio(); ac.remove(); playBtn.remove();
    window.__voiceKokoroInit = false;
};

log('✅ Kokoro TTS loaded (browser-side Replicate API). Toggle 🎵 in gear menu.');
})();

}
