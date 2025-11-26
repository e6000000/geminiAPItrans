// app.js
const CONFIG = { host: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent" };

let audioCtx = null, workletNode = null, micStream = null;
let ws = null, isConnected = false;

const ui = {
    btn: document.getElementById('btnMain'),
    status: document.getElementById('status'),
    mic: document.getElementById('micSelect'),
    spk: document.getElementById('speakerSelect')
};

// --- INIT ---
async function init() {
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devs = await navigator.mediaDevices.enumerateDevices();
        ui.mic.innerHTML = ''; ui.spk.innerHTML = '';
        devs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || d.kind;
            if(d.kind==='audioinput') ui.mic.appendChild(opt);
            if(d.kind==='audiooutput') ui.spk.appendChild(opt);
        });
        // VoiceMeeter Auto-Select
        const vm = Array.from(ui.mic.options).find(o => o.text.includes("VoiceMeeter Out"));
        if(vm) ui.mic.value = vm.value;
    } catch(e) { ui.status.innerText = "Kein Mic!"; }
}

// --- START ---
ui.btn.onclick = async () => {
    if (isConnected) return stop();
    if (typeof CONFIG_API_KEY === 'undefined') return alert("config.js fehlt!");

    ui.btn.disabled = true;
    ui.btn.innerText = "Verbinde...";
    
    try {
        // 1. Audio Context
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        
        // 2. Externen Processor laden
        await audioCtx.audioWorklet.addModule('processor.js');

        // 3. WebSocket
        ws = new WebSocket(`${CONFIG.host}?key=${CONFIG_API_KEY}`);
        
        ws.onopen = async () => {
            ui.status.innerText = "Verbunden. Warte 5s auf Audio...";
            ui.status.style.color = "#10b981"; // Grün
            
            // Setup senden
            ws.send(JSON.stringify({
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: { response_modalities: ["AUDIO"] },
                    system_instruction: { parts: [{ text: "Translate to English." }] }
                }
            }));

            // 4. Mikrofon starten & mit Worklet verbinden
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: ui.mic.value }, channelCount: 1, sampleRate: 16000 }
            });
            
            const source = audioCtx.createMediaStreamSource(micStream);
            workletNode = new AudioWorkletNode(audioCtx, 'five-second-processor');

            // Wenn der Processor (alle 5s) feuert:
            workletNode.port.onmessage = (e) => {
                if (ws.readyState === WebSocket.OPEN) {
                    sendToGoogle(e.data);
                    ui.status.innerText = "Paket gesendet! (Warte 5s...)";
                }
            };

            source.connect(workletNode);
            workletNode.connect(audioCtx.destination); // "Silent Connect" damit es läuft
            
            isConnected = true;
            ui.btn.disabled = false;
            ui.btn.innerText = "STOP";
            ui.btn.style.background = "#ef4444";
        };

        ws.onmessage = async (e) => {
            const d = JSON.parse(e.data instanceof Blob ? await e.data.text() : e.data);
            if (d.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                playAudio(d.serverContent.modelTurn.parts[0].inlineData.data);
            }
        };

        ws.onclose = (e) => stop(e.code === 1011 ? "⚠️ Quota Limit" : "Getrennt");

    } catch (e) { stop("Fehler: " + e); }
};

function sendToGoogle(float32Data) {
    // Konvertierung Float32 -> Int16 PCM
    const pcm16 = new Int16Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Data[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Base64 Encoding (Chunked für große Pakete)
    const bytes = new Uint8Array(pcm16.buffer);
    let binary = '';
    const len = bytes.byteLength;
    // Wir machen es in Blöcken, damit der Browser bei großen Strings nicht abstürzt
    for (let i = 0; i < len; i+=32768) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 32768, len)));
    }
    
    ws.send(JSON.stringify({
        realtime_input: { media_chunks: [{ mime_type: "audio/pcm", data: btoa(binary) }] }
    }));
}

function playAudio(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for(let i=0; i<int16.length; i++) float32[i] = int16[i] / 32768;

    const buf = audioCtx.createBuffer(1, float32.length, 24000);
    buf.copyToChannel(float32, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
}

function stop(msg) {
    isConnected = false;
    if (ws) ws.close();
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    
    ui.btn.disabled = false;
    ui.btn.innerText = "START (5s Takt)";
    ui.btn.style.background = ""; // Reset Farbe
    if(msg) ui.status.innerText = msg;
}

init();