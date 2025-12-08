import { log, formatTime } from './utils.js';
import { parseManifest } from './manifest-parser.js';

export class DashPlayer {
    constructor(videoElement) {
        this.video = videoElement;
        this.mediaSource = null;
        this.sourceBuffer = null;

        this.baseUrl = "http://localhost:8080/dash/";
        this.qualities = [];
        this.currentQualityIndex = 0;
        this.segmentDuration = 4.0;

        this.totalDuration = 0;

        this.queue = [];
        this.isAppending = false;
        this.nextSegmentIndex = 1;
        this.isDownloading = false;
        this.initialized = false;
        this.isStopped = false;
        this.qualityChanged = false;

        this.lastDownloadSpeed = 0;
        this.minBufferTime = 10;

        this.videoSegments = [];

        this.seekBar = document.getElementById('seekBar');
        this.timeDisplay = document.getElementById('timeDisplay');

        this.setupEventListeners();
        this.setupSeekControl();
    }

    setupEventListeners() {
        this.mediaSource = new MediaSource();
        this.video.src = URL.createObjectURL(this.mediaSource);

        this.mediaSource.addEventListener('sourceopen', () => {
            log("MediaSource Aberto.");
        });

        setInterval(() => this.bufferLoop(), 1000);
        this.video.addEventListener('timeupdate', () => this.updateStats());
    }

    setupSeekControl() {
        if (!this.seekBar) return;

        // O evento 'input' ocorre enquanto arrasta, 'change' ao soltar.
        // Usamos 'change' para evitar spam de requisições.
        this.seekBar.addEventListener('change', (e) => {
            const targetTime = parseFloat(e.target.value);
            this.seek(targetTime);
        });

        this.seekBar.addEventListener('input', () => {
            const val = this.seekBar.value;
            this.updateTimeDisplay(val, this.totalDuration);
        });
    }

    getSegmentForTime(time) {
        let seg = null;
        for (const s of this.videoSegments) {
            if (time >= s.start && time < s.end) {
                seg = s;
                break;
            }
        }
        return seg;
    }

    seek(time) {
        if (time < 0) time = 0;
        if (time >= this.totalDuration) time = this.totalDuration - 0.1;

        this.video.currentTime = time;

        // Usa o novo mapa para achar o índice correto
        const targetSeg = this.getSegmentForTime(time);

        if (targetSeg) {
            log(`Seek ${time.toFixed(2)}s -> Segmento ${targetSeg.index} (Início: ${targetSeg.start.toFixed(2)}s)`);
            this.nextSegmentIndex = targetSeg.index;
        } else {
            // Fallback (caso o mapa falhe)
            this.nextSegmentIndex = 1;
        }

        // Limpeza padrão
        this.queue = [];
        this.isAppending = false;
        this.isStopped = false;
        if (this.sourceBuffer && this.sourceBuffer.updating) {
            try { this.sourceBuffer.abort(); } catch (e) { }
        }
        this.isDownloading = false;
        this.bufferLoop();
    }

    async loadManifest() {
        if (this.isStopped) return;
        try {
            const response = await fetch(this.baseUrl + "manifest.mpd");
            if (!response.ok) throw new Error("Erro HTTP manifesto");
            const text = await response.text();

            const result = parseManifest(text);
            if (result.success) {
                this.totalDuration = result.totalDuration;
                this.videoSegments = result.videoSegments;
                this.qualities = result.qualities;

                if (this.mediaSource.readyState === 'open') {
                    this.mediaSource.duration = this.totalDuration;
                }

                if (this.seekBar) this.seekBar.max = this.totalDuration;

                await this.initializeSourceBuffer();
                await this.downloadInitSegment();

                try { await this.video.play(); } catch (e) { console.log("Autoplay bloqueado"); }
            }
        } catch (e) {
            log(e.message, 'error');
        }
    }

    async initializeSourceBuffer() {
        if (this.sourceBuffer) return;
        const q = this.qualities[0];
        const mime = `${q.mimeType}; codecs="${q.codecs}"`;
        if (MediaSource.isTypeSupported(mime)) {
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
            this.sourceBuffer.addEventListener('updateend', () => {
                this.isAppending = false;
                this.processQueue();
            });
        }
    }

    processQueue() {
        if (this.queue.length > 0 && !this.sourceBuffer.updating) {
            this.isAppending = true;
            const data = this.queue.shift();
            try { this.sourceBuffer.appendBuffer(data); }
            catch (e) { this.isStopped = true; }
        }
    }

    addToBuffer(data) {
        if (this.isStopped && !this.sourceBuffer.updating) return; // Segurança
        this.queue.push(data);
        if (!this.isAppending && this.sourceBuffer && !this.sourceBuffer.updating) {
            this.processQueue();
        }
    }

    async downloadInitSegment() {
        this.queue = [];
        const q = this.qualities[this.currentQualityIndex];
        const url = `${this.baseUrl}video/${q.id}/init.mp4`;
        try {
            const data = await this.fetchSegment(url);
            this.addToBuffer(data);
            this.initialized = true;
        } catch (e) { log("Erro init", "error"); }
    }

    async fetchSegment(url) {
        const t0 = performance.now();
        const res = await fetch(url);
        if (res.status === 404) throw new Error("EOS");
        if (!res.ok) throw new Error(res.status);
        const buf = await res.arrayBuffer();
        const sec = (performance.now() - t0) / 1000;
        this.lastDownloadSpeed = (buf.byteLength * 8) / sec;
        return buf;
    }

    async bufferLoop() {
        if (!this.initialized || this.isDownloading || this.isStopped) return;

        // Se buffer estiver muito cheio, pausa download (economia de banda)
        const bufferEnd = this.getBufferEnd();
        const ahead = bufferEnd - this.video.currentTime;

        if (ahead < this.minBufferTime) {
            this.checkQoS();
            this.isDownloading = true;
            await this.downloadNextChunk();
            this.isDownloading = false;
        }
    }

    checkQoS() {
        const available = this.lastDownloadSpeed * 0.7;
        let bestIdx = 0;
        for (let i = 0; i < this.qualities.length; i++) {
            if (available >= this.qualities[i].bandwidth) bestIdx = i;
        }
        if (bestIdx !== this.currentQualityIndex) {
            this.currentQualityIndex = bestIdx;
            this.qualityChanged = true;
        }
    }

    async downloadNextChunk() {
        // Se o índice atual for maior que o último índice mapeado, fim do vídeo.
        if (this.videoSegments.length > 0) {
            const lastSeg = this.videoSegments[this.videoSegments.length - 1];
            if (this.nextSegmentIndex > lastSeg.index) {
                log("Fim da lista de segmentos.", "success");
                if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
                this.isStopped = true;
                return;
            }
        }

        if (this.qualityChanged) {
            await this.downloadInitSegment();
            this.qualityChanged = false;
        }

        const q = this.qualities[this.currentQualityIndex];
        const url = `${this.baseUrl}video/${q.id}/${this.nextSegmentIndex}`;

        try {
            const maxSegments = Math.ceil(this.totalDuration / this.segmentDuration);
            if (this.nextSegmentIndex > maxSegments && this.totalDuration > 0) {
                throw new Error("EOS");
            }

            log(`Baixando Chunk ${this.nextSegmentIndex}`);
            const data = await this.fetchSegment(url);
            this.addToBuffer(data);
            this.nextSegmentIndex++;
        } catch (e) {
            if (e.message === "EOS") {
                log("Fim do vídeo");
                if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
                this.isStopped = true;
            } else {
                log("Erro chunk: " + e.message, 'warn');
            }
        }
    }

    getBufferEnd() {
        const b = this.video.buffered;
        const t = this.video.currentTime;
        for (let i = 0; i < b.length; i++) {
            if (t >= b.start(i) && t <= b.end(i)) return b.end(i);
        }
        return 0;
    }

    updateTimeDisplay(current, total) {
        if (this.timeDisplay) {
            this.timeDisplay.innerText = `${formatTime(current)} / ${formatTime(total)}`;
        }
    }

    updateStats() {
        if (!this.qualities.length) return;

        const q = this.qualities[this.currentQualityIndex];
        document.getElementById('currentQuality').innerText = `Qualidade: ${q.height}p`;
        document.getElementById('bandwidth').innerText = `Banda: ${(this.lastDownloadSpeed / 1000000).toFixed(2)} Mbps`;

        const current = this.video.currentTime;
        const bufferEnd = this.getBufferEnd();

        document.getElementById('bufferLevel').innerText = `Buffer: ${(bufferEnd - current).toFixed(1)}s`;

        if (this.seekBar && Math.abs(this.seekBar.value - current) > 1.0) {
            this.seekBar.value = current;
        }
        this.updateTimeDisplay(current, this.totalDuration);
    }
}
