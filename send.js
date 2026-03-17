// ═══════════════════════════════════════════════════════════════════════
// Voice Widget Module: Send & Restart — The Messenger
//
// DESIGN: Package voice commands as HTTP POST to /add_relative_,
// then handle post-send state transitions (back to listen or idle).
// ═══════════════════════════════════════════════════════════════════════

if (!window.__voiceSendInit) {
window.__voiceSendInit = true;

(function() {
const V = window._voice;
if (!V) { console.error('[Send] No voice widget'); return; }
if (V._sendCleanup) V._sendCleanup();

const log = V.log;

async function sendTranscript(text) {
    V.setStatus('📤 Sending: ' + text.slice(0, 40) + '...', V.CLR.warn);
    try {
        const params = {
            dlg_name: V.getDname(),
            content: (V.autoCb.checked ? '🎤 Voice [autorun]: ' : '🎤 Voice: ') + text,
            msg_type: V.msgType,
            placement: V.anchorId ? 'add_before' : 'at_end',
        };
        // DESIGN: Only prompts auto-run. Omit run key entirely for code/note
        // because the server treats any string as truthy.
        if (V.msgType === 'prompt') params.run = 'true';
        if (V.anchorId) params.id_ = V.anchorId;

        const body = new URLSearchParams(params);
        const resp = await fetch('/add_relative_', { method: 'POST', body });

        if (resp.ok) V.setStatus('✅ Sent!', V.CLR.ok);
        else V.setStatus('❌ Error: ' + resp.status, V.CLR.err);
    } catch(e) {
        V.setStatus('❌ ' + e.message, V.CLR.err);
    }
}

async function sendAndRestart(text) {
    try { await sendTranscript(text); }
    catch(e) { log('Send error:', e); V.setStatus('❌ ' + e.message, V.CLR.err); }
    finally {
        if (V.toggleCb.checked && !V.destroyed) {
            V.safeStart(V.CFG.postSendMs);
            V.go('listen', 'send complete, back to listening');
        } else {
            V.resetUI();
            V.go('idle', 'send complete, no continuous');
        }
    }
}

V.sendTranscript = sendTranscript;
V.sendAndRestart = sendAndRestart;

V._sendCleanup = () => {
    delete V.sendTranscript; delete V.sendAndRestart; delete V._sendCleanup;
    window.__voiceSendInit = false;
    log('[Send] Cleaned up');
};

log('✅ Send & Restart module loaded');
})();

}
