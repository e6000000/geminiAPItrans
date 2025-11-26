// processor.js
class BufferedProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // 8000 Samples = ca. 0.5 Sekunden bei 16kHz
        // Das verhindert "Too Many Requests" zuverlässig.
        this.bufferSize = 8000; 
        this.buffer = new Float32Array(this.bufferSize);
        this.index = 0;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        if (input && input.length > 0) {
            const channel = input[0];
            for (let i = 0; i < channel.length; i++) {
                this.buffer[this.index++] = channel[i];
                
                // Wenn Buffer voll ist -> Senden!
                if (this.index >= this.bufferSize) {
                    this.port.postMessage(this.buffer);
                    this.index = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('buffered-processor', BufferedProcessor);