// processor.js
class FiveSecondProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // 16.000 Hz * 5 Sekunden = 80.000 Samples
        // Das garantiert, dass wir nur 12 mal pro Minute senden.
        this.bufferSize = 80000; 
        this.buffer = new Float32Array(this.bufferSize);
        this.index = 0;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        if (input && input.length > 0) {
            const channel = input[0];
            for (let i = 0; i < channel.length; i++) {
                // Wir füllen den Puffer Sample für Sample
                this.buffer[this.index++] = channel[i];
                
                // Erst wenn der Puffer VOLL ist (nach 5 Sekunden), senden wir
                if (this.index >= this.bufferSize) {
                    // Klonen, damit der Hauptthread die Daten sicher hat
                    const dataToSend = this.buffer.slice(); 
                    this.port.postMessage(dataToSend);
                    
                    // Reset für die nächsten 5 Sekunden
                    this.index = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('five-second-processor', FiveSecondProcessor);