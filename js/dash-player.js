export class DashPlayer {
    constructor(videoElement, serverUrl, onLog, onStatsUpdate) {
        this.video = videoElement;
        this.SERVER = serverUrl;
        this.MANIFEST_URL = this.SERVER + '/dash/manifest.mpd';
        this.onLog = onLog || console.log;
        this.onStatsUpdate = onStatsUpdate || (() => { });
        this.handleSourceOpen = this.handleSourceOpen.bind(this);

        // Config
        this.SEGMENT_DURATION_S = 2.0;
        this.APPEND_RETRY_MS = 500;

        // State
        this.qualities = [];
        this.autoAbr = true;
        this.currentQualityIndex = 0;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.isAppending = false;
        this.segmentQueue = [];
        this.nextSegmentIndex = 1;
        this.isRunning = false;
        this.segmentsDownloaded = 0;
        this.lastDownloadBytes = 0;
        this.lastDownloadMs = 0;
        this.recentSpeeds = [];
        this.manualQuality = null;
        this.seenInitForQuality = {};
        this.loopActive = false;
    }

    log(...args) {
        this.onLog(...args);
    }

    async fetchManifest() {
        this.log('Buscando manifest...', this.MANIFEST_URL);
        const r = await fetch(this.MANIFEST_URL);
        if (!r.ok) {
            throw new Error('Erro ao buscar manifest: ' + r.status);
        }
        const txt = await r.text();

        const parser = new DOMParser();
        const xml = parser.parseFromString(txt, "application/xml");
        const reps = xml.getElementsByTagName('Representation');

        const set = new Set();
        for (let i = 0; i < reps.length; i++) {
            const rep = reps[i];
            const mime = rep.getAttribute('mimeType');
            // Filtra apenas representações de vídeo
            if (mime && mime.startsWith('video/')) {
                set.add(rep.getAttribute('id'));
            }
        }

        this.qualities = Array.from(set);
        this.qualities.sort((a, b) => {
            const na = parseInt(a) || 0;
            const nb = parseInt(b) || 0;
            return na - nb;
        });
        if (this.qualities.length === 0) {
            throw new Error('Nenhuma qualidade encontrada no manifest.');
        }
        this.log('Qualidades detectadas:', this.qualities);
        return this.qualities;
    }

    async start() {
        // Evita recriar MediaSource se já existir e estiver aberto/aberto
        if (this.mediaSource && this.mediaSource.readyState !== 'closed') {
            this.log('MediaSource já inicializado; retomando reprodução.');
            this.video.play();
            return;
        }
        if (this.isRunning) {
            this.video.play();
            return;
        }
        this.isRunning = true;
        this.log('Iniciando player...');

        if (this.qualities.length === 0) {
            await this.fetchManifest();
        }

        this.mediaSource = new MediaSource();
        this.video.src = URL.createObjectURL(this.mediaSource);

        // Usa handler vinculado e dispara apenas uma vez
        this.mediaSource.addEventListener('sourceopen', this.handleSourceOpen, { once: true });
    }

    handleSourceOpen(ev) {
        // Garante que tratamos apenas o MediaSource atual
        if (ev.target !== this.mediaSource) return;
        this.log('MediaSource aberto');
        const mime = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
        try {
            if (this.sourceBuffer) return; // já existe
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
            this.sourceBuffer.mode = 'segments';
        } catch (e) {
            this.log('Erro ao criar SourceBuffer.', e.message);
            return;
        }

        this.sourceBuffer.addEventListener('updateend', () => this.onUpdateEnd());

        this.nextSegmentIndex = 1;
        this.segmentQueue = [];
        this.segmentsDownloaded = 0;
        this.recentSpeeds = [];
        this.seenInitForQuality = {};

        this.scheduleLoop();
    }

    appendFromQueue() {
        // Não tente anexar se o MediaSource não estiver aberto
        if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;
        if (!this.sourceBuffer || this.isAppending || this.sourceBuffer.updating) return;
        if (this.segmentQueue.length === 0) return;
        const chunk = this.segmentQueue.shift();
        try {
            this.isAppending = true;
            this.sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            this.segmentQueue.unshift(chunk);
            this.isAppending = false;
            this.log('Falha ao adicionar ao SourceBuffer, tentando novamente em',
                this.APPEND_RETRY_MS, 'ms:', e.message);
            setTimeout(() => this.appendFromQueue(), this.APPEND_RETRY_MS);
        }
    }

    pause() {
        this.video.pause();
    }

    setQuality(index) {
        if (index >= 0 && index < this.qualities.length) {
            this.manualQuality = index;
            this.currentQualityIndex = index;
            this.log('Qualidade manual selecionada:', this.qualities[index]);
        }
    }

    setTargetBuffer(seconds) {
        this.targetBuffer = seconds;
    }

    onUpdateEnd() {
        this.isAppending = false;
        this.appendFromQueue();
    }

    // ÚNICA versão de appendFromQueue (a duplicada foi removida)
    appendFromQueue() {
        // Verificações de segurança
        if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;
        if (!this.sourceBuffer || this.isAppending || this.sourceBuffer.updating) return;
        if (this.segmentQueue.length === 0) return;

        const chunk = this.segmentQueue.shift();
        try {
            this.isAppending = true;
            this.sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            // Se o SourceBuffer foi removido ou o MediaSource fechou, pare o loop
            if (e && typeof e.message === 'string' && e.message.includes('removed')) {
                this.log('SourceBuffer removido; parando o player.');
                this.isRunning = false;
                return;
            }
            this.segmentQueue.unshift(chunk);
            this.isAppending = false;
            this.log('Falha ao adicionar ao SourceBuffer, tentando novamente em',
                this.APPEND_RETRY_MS, 'ms:', e.message);
            setTimeout(() => this.appendFromQueue(), this.APPEND_RETRY_MS);
        }
    }

    scheduleLoop() {
        if (this.loopActive) return;
        this.loopActive = true;
        const loop = async () => {
            while (this.isRunning) {
                try {
                    const target = this.targetBuffer || 12.0;
                    const currentBuffered = this.estimateBufferedSeconds() + (this.segmentQueue.length * this.SEGMENT_DURATION_S);

                    if (currentBuffered < target) {
                        await this.ensureInitForQuality(this.currentQualityIndex);
                        await this.fetchAndQueueSegment(this.currentQualityIndex, this.nextSegmentIndex);
                        this.nextSegmentIndex += 1;

                        if (this.autoAbr && this.manualQuality === null) {
                            this.adaptQuality();
                        }
                    }
                    this.onStatsUpdate(this.getStats());
                    this.appendFromQueue();
                } catch (e) {
                    this.log('Erro no loop principal:', e.message);
                }
                await this.sleep(100);
            }
            this.loopActive = false;
        };
        loop();
    }

    sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

    async ensureInitForQuality(qIndex) {
        const quality = this.qualities[qIndex];
        if (this.seenInitForQuality[quality]) return;

        const url = `${this.SERVER}/dash/video/${quality}/init.mp4`;
        this.log('Baixando init:', url);
        const start = performance.now();
        const r = await fetch(url);
        if (!r.ok) {
            this.log('Init não encontrado para', quality, r.status);
            this.seenInitForQuality[quality] = true;
            return;
        }
        const arr = new Uint8Array(await r.arrayBuffer());
        const msTime = performance.now() - start;
        this.recordDownload(arr.byteLength, msTime);
        this.segmentQueue.unshift(arr);
        this.seenInitForQuality[quality] = true;
        this.log('Init baixado', quality, 'bytes=', arr.byteLength, 'ms=', msTime.toFixed(1));
    }

    async fetchAndQueueSegment(qIndex, segIndex) {
        const quality = this.qualities[qIndex];
        const urlNoExt = `${this.SERVER}/dash/video/${quality}/${segIndex}`;
        const urlWithExt = `${this.SERVER}/dash/video/${quality}/${segIndex}.m4s`;
        let r, start;
        try {
            start = performance.now();
            r = await fetch(urlNoExt);
            if (!r.ok) {
                r = await fetch(urlWithExt);
            }
        } catch (e) {
            this.log('Erro fetch segmento', quality, segIndex, e.message);
            return;
        }
        if (!r.ok) {
            this.log('Segmento não encontrado', quality, segIndex, r.status);
            await this.sleep(500);
            return;
        }
        const arr = new Uint8Array(await r.arrayBuffer());
        const msTime = Math.max(1, performance.now() - start);
        this.segmentsDownloaded += 1;
        this.recordDownload(arr.byteLength, msTime);
        this.segmentQueue.push(arr);
        this.log(`Segmento ${segIndex} [${quality}] baixado: ${arr.byteLength} bytes em ${msTime.toFixed(1)} ms`);
        this.onStatsUpdate(this.getStats());
    }

    recordDownload(bytes, ms) {
        const bpm = bytes / ms;
        this.recentSpeeds.push(bpm);
        if (this.recentSpeeds.length > 10) this.recentSpeeds.shift();
        this.lastDownloadBytes = bytes;
        this.lastDownloadMs = ms;
    }

    adaptQuality() {
        if (this.recentSpeeds.length === 0) return;
        const lastMs = this.lastDownloadMs;
        if (!lastMs) return;

        if (lastMs > this.SEGMENT_DURATION_S * 1000 * 0.95) {
            if (this.currentQualityIndex > 0) {
                this.currentQualityIndex = Math.max(0, this.currentQualityIndex - 1);
                this.log('ABR: Reduzindo qualidade para', this.qualities[this.currentQualityIndex], 'porque download lento:', lastMs.toFixed(1), 'ms');
            }
        } else {
            if (lastMs < this.SEGMENT_DURATION_S * 1000 * 0.45) {
                if (this.currentQualityIndex < this.qualities.length - 1) {
                    this.currentQualityIndex = Math.min(this.qualities.length - 1, this.currentQualityIndex + 1);
                    this.log('ABR: Aumentando qualidade para', this.qualities[this.currentQualityIndex], 'download rápido:', lastMs.toFixed(1), 'ms');
                }
            }
        }
    }

    estimateBufferedSeconds() {
        if (!this.video || !this.video.buffered || this.video.buffered.length === 0) return 0;
        try {
            const end = this.video.buffered.end(this.video.buffered.length - 1);
            const now = this.video.currentTime;
            return Math.max(0, end - now);
        } catch (e) { return 0; }
    }

    getStats() {
        const speedBps = this.recentSpeeds.length ? (this.recentSpeeds.reduce((a, b) => a + b, 0) / this.recentSpeeds.length) * 1000 : 0;
        const mbps = (speedBps * 8) / (1024 * 1024);

        return {
            queueLen: this.segmentQueue.length,
            segmentsDownloaded: this.segmentsDownloaded,
            estimatedBuffer: Math.max(0, this.segmentQueue.length * this.SEGMENT_DURATION_S + this.estimateBufferedSeconds()),
            downloadSpeedMbps: mbps,
            currentQuality: this.qualities[this.currentQualityIndex] || '—'
        };
    }
}
