class DashPlayer {
    constructor(videoElement) {
        this.video = videoElement;
        this.mediaSource = null;
        this.sourceBuffer = null;

        this.baseUrl = "http://localhost:8080/dash/";
        this.qualities = [];
        this.currentQualityIndex = 0;
        this.segmentDuration = 4.0;

        this.queue = [];
        this.isAppending = false;
        this.nextSegmentIndex = 1;
        this.isDownloading = false;
        this.initialized = false;
        this.isStopped = false; // Trava de segurança
        this.nextSegmentIndex = 1;
        this.qualityChanged = false;

        this.lastDownloadSpeed = 0;
        this.minBufferTime = 10;

        this.setupEventListeners();
    }

    log(msg, type = 'info') {
        const consoleEl = document.getElementById('logConsole');
        if (!consoleEl) return;
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        consoleEl.prepend(entry);
        console.log(`[${type}] ${msg}`);
    }

    setupEventListeners() {
        this.mediaSource = new MediaSource();
        this.video.src = URL.createObjectURL(this.mediaSource);

        this.mediaSource.addEventListener('sourceopen', () => {
            this.log("MediaSource Aberto. Aguardando manifesto...");
        });

        this.video.addEventListener('error', (e) => {
            if (!this.isStopped) {
                this.isStopped = true;
                const err = this.video.error;
                let msg = "Erro desconhecido";
                if (err) {
                    const errorTypes = {
                        1: "MEDIA_ERR_ABORTED",
                        2: "MEDIA_ERR_NETWORK",
                        3: "MEDIA_ERR_DECODE (Codec Incompatível)",
                        4: "MEDIA_ERR_SRC_NOT_SUPPORTED"
                    };
                    msg = errorTypes[err.code] || msg;
                }
                this.log(`CRITICAL VIDEO ERROR: ${msg}`, 'error');
            }
        });

        // Loop principal (1s)
        setInterval(() => this.bufferLoop(), 1000);

        this.video.addEventListener('timeupdate', () => this.updateStats());
    }

    async loadManifest() {
        if (this.isStopped) return;
        try {
            this.log("Baixando Manifesto...");
            const response = await fetch(this.baseUrl + "manifest.mpd");
            if (!response.ok) throw new Error("Erro HTTP ao baixar manifesto");

            const text = await response.text();
            if (this.parseManifest(text)) {
                await this.initializeSourceBuffer();
                await this.downloadInitSegment();
            }
        } catch (e) {
            this.log(e.message, 'error');
        }
    }

    parseManifest(xmlString) {
        const parser = new DOMParser();
        const xml = parser.parseFromString(xmlString, "text/xml");

        // 1. Duração
        const segmentTemplate = xml.querySelector("SegmentTemplate");
        let timescale = 1, duration = 1;
        if (segmentTemplate) {
            timescale = parseFloat(segmentTemplate.getAttribute("timescale")) || 1;
            duration = parseFloat(segmentTemplate.getAttribute("duration")) || 1;
        }
        this.segmentDuration = duration / timescale;

        if (isNaN(this.segmentDuration) || this.segmentDuration < 0.5) {
            this.segmentDuration = 4.0; // Fallback
        }

        // 2. FILTRAR APENAS VÍDEO (Correção do Erro de Decode)
        const adaptationSets = xml.querySelectorAll("AdaptationSet");
        let videoSet = null;

        for (const as of adaptationSets) {
            const mime = as.getAttribute("mimeType");
            const contentType = as.getAttribute("contentType");

            // Procura explicitamente por vídeo
            if ((mime && mime.includes("video")) || (contentType && contentType === "video")) {
                videoSet = as;
                break;
            }

            // Fallback: olha a primeira representação filha
            const rep = as.querySelector("Representation");
            if (rep && rep.getAttribute("mimeType") && rep.getAttribute("mimeType").includes("video")) {
                videoSet = as;
                break;
            }
        }

        if (!videoSet) {
            this.log("Nenhum stream de vídeo encontrado no manifesto!", "error");
            this.isStopped = true;
            return false;
        }

        const representations = videoSet.querySelectorAll("Representation");
        const defaultCodecs = videoSet.getAttribute("codecs") || "avc1.64001f"; // High Profile

        this.qualities = Array.from(representations).map((rep, index) => {
            return {
                id: rep.getAttribute("id"), // ID do FFmpeg (0, 1, 2)
                bandwidth: parseInt(rep.getAttribute("bandwidth")),
                width: rep.getAttribute("width"),
                height: rep.getAttribute("height"),
                codecs: rep.getAttribute("codecs") || defaultCodecs,
                mimeType: rep.getAttribute("mimeType") || 'video/mp4'
            };
        });

        // Ordena por bitrate
        this.qualities.sort((a, b) => a.bandwidth - b.bandwidth);

        this.log(`Carregadas ${this.qualities.length} qualidades de VÍDEO.`);
        return true;
    }

    async initializeSourceBuffer() {
        if (this.sourceBuffer) return;

        const q = this.qualities[0];
        const mime = `${q.mimeType}; codecs="${q.codecs}"`;

        this.log(`Inicializando Buffer: ${mime}`);

        if (MediaSource.isTypeSupported(mime)) {
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
            this.sourceBuffer.addEventListener('updateend', () => {
                this.isAppending = false;
                this.processQueue();
            });
        } else {
            this.log(`Codec não suportado: ${mime}`, 'error');
            this.isStopped = true;
        }
    }

    processQueue() {
        if (this.isStopped) return;
        if (this.queue.length > 0 && !this.sourceBuffer.updating) {
            this.isAppending = true;
            const data = this.queue.shift();
            try {
                this.sourceBuffer.appendBuffer(data);
            } catch (e) {
                this.log("Erro no appendBuffer. Reiniciando player...", 'error');
                this.isStopped = true;
            }
        }
    }

    addToBuffer(data) {
        if (this.isStopped) return;
        this.queue.push(data);
        if (!this.isAppending && this.sourceBuffer && !this.sourceBuffer.updating) {
            this.processQueue();
        }
    }

    async downloadInitSegment() {
        // Limpa fila ao trocar qualidade/iniciar
        this.queue = [];

        const q = this.qualities[this.currentQualityIndex];
        const url = `${this.baseUrl}video/${q.id}/init.mp4`;

        try {
            const data = await this.fetchSegment(url);
            this.addToBuffer(data);
            this.initialized = true;
            this.log(`Init carregado (ID: ${q.id})`);
        } catch (e) {
            this.log(`Falha Init: ${e.message}`, 'error');
        }
    }

    async fetchSegment(url) {
        const t0 = performance.now();
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        const buf = await res.arrayBuffer();

        const sec = (performance.now() - t0) / 1000;
        this.lastDownloadSpeed = (buf.byteLength * 8) / sec;

        return buf;
    }

    async bufferLoop() {
        if (!this.initialized || this.isDownloading || this.isStopped) return;

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
            if (available >= this.qualities[i].bandwidth) {
                bestIdx = i;
            }
        }

        if (bestIdx !== this.currentQualityIndex) {
            this.log(`QoS: ${this.qualities[this.currentQualityIndex].height}p -> ${this.qualities[bestIdx].height}p`, 'qos');
            this.currentQualityIndex = bestIdx;
            this.qualityChanged = true;
        }
    }

    async downloadNextChunk() {
        // Se a qualidade mudou, baixa o Init da nova qualidade PRIMEIRO
        if (this.qualityChanged) {
            this.log("Trocando qualidade... Baixando novo Init.");
            await this.downloadInitSegment();
            this.qualityChanged = false;
        }

        const q = this.qualities[this.currentQualityIndex];
        const url = `${this.baseUrl}video/${q.id}/${this.nextSegmentIndex}.m4s`;

        try {
            this.log(`Baixando Chunk ${this.nextSegmentIndex} (${q.height}p)`);
            const data = await this.fetchSegment(url);
            this.addToBuffer(data);
            this.nextSegmentIndex++;
        } catch (e) {
            this.log("Fim do vídeo ou erro de rede.", 'warn');
            this.isStopped = true;
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

    updateStats() {
        if (!this.qualities.length) return;
        const q = this.qualities[this.currentQualityIndex];

        document.getElementById('currentQuality').innerText = `Qualidade: ${q.height}p`;
        document.getElementById('bufferLevel').innerText = `Buffer: ${(this.getBufferEnd() - this.video.currentTime).toFixed(1)}s`;
        document.getElementById('bandwidth').innerText = `Banda: ${(this.lastDownloadSpeed / 1000000).toFixed(2)} Mbps`;
    }
}

// Init
const player = new DashPlayer(document.getElementById('videoPlayer'));
document.getElementById('btnLoad').addEventListener('click', () => player.loadManifest());
