// app.js
// 
// Hier ist die Logik für Buttons, WebSocket und UI. Sie lädt automatisch die processor.js.
// 
const CONFIG = { host: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent" };

let audioCtx = null, workletNode = null, micStream = null, micSource = null;
let inputAnalyser = null, outputAnalyser = null, ws = null;
let isConnected = false, nextStartTime = 0;

const ui = {
    mic: document.getElementById('micSelect'),
    spk: document.getElementById('speakerSelect'),
    model: document.getElementById('modelSelect'),
    lang: document.getElementById('targetLang'),
    voice: document.getElementById('voiceName'),
    btn: document.getElementById('btnMain'),
    status: document.getElementById('status'),
    fillIn: document.getElementById('fillIn'),
    fillOut: document.getElementById('fillOut')
};

// --- INIT ---
async function init() {
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        ui.mic.innerHTML = ''; ui.spk.innerHTML = '';
        
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || d.kind;
            if(d.kind === 'audioinput') ui.mic.appendChild(opt);
            if(d.kind === 'audiooutput') ui.spk.appendChild(opt);
        });

        const vmIn = Array.from(ui.mic.options).find(o => o.text.includes("VoiceMeeter Out"));
        if(vmIn) ui.mic.value = vmIn.value;
        
        startMonitoring();
    } catch(e) { ui.status.innerText = "Mikrofon fehlt!"; }
}

// --- MONITORING ---
async function startMonitoring() {
    if(audioCtx) await audioCtx.close();
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    
    // HIER LADEN WIR DAS EXTERNE FILE
    try {
        await audioCtx.audioWorklet.addModule('processor.js');
    } catch(e) {
        console.error("Konnte processor.js nicht laden. Server gestartet?", e);
        ui.status.innerText = "Fehler: processor.js fehlt!";
        return;
    }

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: ui.mic.value }, channelCount: 1, sampleRate: 16000 }
        });

        micSource = audioCtx.createMediaStreamSource(micStream);
        inputAnalyser = audioCtx.createAnalyser();
        inputAnalyser.fftSize = 256;
        outputAnalyser = audioCtx.createAnalyser();
        outputAnalyser.fftSize = 256;

        micSource.connect(inputAnalyser);
        outputAnalyser.connect(audioCtx.destination);
        
        drawMeters();
    } catch(e) {}
}
ui.mic.onchange = startMonitoring;

function drawMeters() {
    if(!audioCtx) return;
    const dIn = new Uint8Array(inputAnalyser.frequencyBinCount);
    inputAnalyser.getByteFrequencyData(dIn);
    ui.fillIn.style.width = Math.min(100, (dIn[0]/255)*300) + "%";

    const dOut = new Uint8Array(outputAnalyser.frequencyBinCount);
    outputAnalyser.getByteFrequencyData(dOut);
    ui.fillOut.style.width = Math.min(100, (dOut[0]/255)*300) + "%";
    requestAnimationFrame(drawMeters);
}

// --- START / STOP ---
ui.btn.onclick = async () => {
    if (isConnected) return disconnect("Beendet");
    if(typeof CONFIG_API_KEY === 'undefined') return alert("config.js fehlt!");
    if(audioCtx.state === 'suspended') await audioCtx.resume();
    if(audioCtx.setSinkId && ui.spk.value) try { await audioCtx.setSinkId(ui.spk.value); } catch(e){}

    ui.btn.textContent = "Verbinde...";
    ui.btn.className = "btn-connecting";
    ui.btn.disabled = true;

    try { ws = new WebSocket(`${CONFIG.host}?key=${CONFIG_API_KEY}`); } catch(e) { return disconnect("WS Fehler"); }

    // Worklet Node erstellen (Nutzt die Klasse aus processor.js)
    workletNode = new AudioWorkletNode(audioCtx, 'buffered-processor');
    
    workletNode.port.onmessage = (e) => {
        if(!isConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
        
        const float32 = e.data;
        const pcm = new Int16Array(float32.length);
        for(let i=0; i<float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        const b64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
        try {
            ws.send(JSON.stringify({ realtime_input: { media_chunks: [{ mime_type: "audio/pcm", data: b64 }] } }));
        } catch(err) {}
    };

    inputAnalyser.disconnect();
    inputAnalyser.connect(workletNode);
    workletNode.connect(audioCtx.destination); 

    ws.onopen = () => {
        const setup = {
            setup: {
                model: ui.model.value,
                generation_config: { 
                    response_modalities: ["AUDIO"],
                    speech_config: { voice_config: { prebuilt_voice_config: { voice_name: ui.voice.value } } }
                },
                system_instruction: { parts: [{ text: `You are a translator. Translate to ${ui.lang.value}.` }] }
            }
        };
        ws.send(JSON.stringify(setup));
        
        setTimeout(() => {
            if(ws && ws.readyState === WebSocket.OPEN) {
                isConnected = true;
                ui.btn.textContent = "Verbindung Trennen";
                ui.btn.className = "btn-live";
                ui.btn.disabled = false;
                ui.status.innerHTML = "<span style='color:var(--green)'>● ONLINE</span>";
                nextStartTime = audioCtx.currentTime;
            } else {
                if(!isConnected) disconnect("Verbindung abgelehnt");
            }
        }, 1000);
    };

    ws.onmessage = async (evt) => {
        const data = JSON.parse(evt.data instanceof Blob ? await evt.data.text() : evt.data);
        if(data.serverContent?.modelTurn?.parts) {
            data.serverContent.modelTurn.parts.forEach(p => {
                if(p.inlineData?.mimeType.startsWith('audio')) playAudio(p.inlineData.data);
            });
        }
    };

    ws.onclose = (e) => {
        if(e.code === 1011) disconnect("⚠️ Limit erreicht (Warte kurz)");
        else disconnect("Getrennt");
    };
    
    ws.onerror = (e) => { disconnect("Netzwerkfehler"); };
};

function disconnect(msg) {
    isConnected = false;
    if(ws) ws.close();
    if(workletNode) { workletNode.disconnect(); workletNode = null; }
    
    if(inputAnalyser && micSource) {
        inputAnalyser.disconnect();
        micSource.connect(inputAnalyser);
    }

    ui.btn.textContent = "Session Starten";
    ui.btn.className = "btn-ready";
    ui.btn.disabled = false;
    ui.status.innerText = msg;
    ui.status.style.color = msg.includes("⚠️") ? "#ef4444" : "#64748b";
}

function playAudio(b64) {
    if(!audioCtx) return;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    const pcm = new Int16Array(bytes.buffer);
    const float = new Float32Array(pcm.length);
    for(let i=0; i<pcm.length; i++) float[i] = pcm[i] / 32768;

    const buf = audioCtx.createBuffer(1, float.length, 24000);
    buf.copyToChannel(float, 0);

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    if(outputAnalyser) src.connect(outputAnalyser);
    else src.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if(nextStartTime < now) nextStartTime = now;
    src.start(nextStartTime);
    nextStartTime += buf.duration;
}

// Start
init();