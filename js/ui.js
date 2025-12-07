export class PlayerUI {
    constructor(player) {
        this.player = player;

        // Elementos
        this.btnStart = document.getElementById('btnStart');
        this.btnPause = document.getElementById('btnPause');
        this.qualitySelect = document.getElementById('qualitySelect');
        this.targetBufferInput = document.getElementById('targetBuffer');

        this.curQualityEl = document.getElementById('curQuality');
        this.bufferSecondsEl = document.getElementById('bufferSeconds');
        this.downloadSpeedEl = document.getElementById('downloadSpeed');
        this.queueLenEl = document.getElementById('queueLen');
        this.segmentsDownloadedEl = document.getElementById('segmentsDownloaded');
        this.logEl = document.getElementById('log');

        this.initEvents();
    }

    initEvents() {
        video.addEventListener('play', () => player.start());
        video.addEventListener('pause', () => player.pause());

        this.btnStart.addEventListener('click', async () => {
            if (!this.player) return;
            await this.player.start();
        });

        this.btnPause.addEventListener('click', () => {
            if (!this.player) return;
            this.player.pause();
            this.log('Pausado.');
        });

        this.qualitySelect.addEventListener('change', () => {
            if (!this.player) return;
            const val = this.qualitySelect.value;
            if (val === 'auto') {
                this.player.enableAutoAbr();
                this.log('Qualidade: Auto (ABR)');
            } else {
                const idx = parseInt(val, 10);
                if (!Number.isNaN(idx)) {
                    this.player.setQuality(idx);
                    const label = this.player.qualities[idx] ?? idx;
                    this.log(`Qualidade fixa: ${label}`);
                }
            }
        });

        this.targetBufferInput.addEventListener('change', () => {
            if (!this.player) return;
            const v = parseFloat(this.targetBufferInput.value);
            if (!isNaN(v)) this.player.setTargetBuffer(v);
        });
    }

    populateQualitySelect(qualities, currentIndex) {
        this.qualitySelect.innerHTML = '';

        const optAuto = document.createElement('option');
        optAuto.value = 'auto';
        optAuto.textContent = 'Auto (ABR)';
        this.qualitySelect.appendChild(optAuto);

        qualities.forEach((q, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = q;
            this.qualitySelect.appendChild(opt);
        });

        this.qualitySelect.value = 'auto';
        this.curQualityEl.textContent = 'auto';
    }

    updateStats(stats) {
        this.queueLenEl.innerText = stats.queueLen;
        this.segmentsDownloadedEl.innerText = stats.segmentsDownloaded;
        this.bufferSecondsEl.innerText = stats.estimatedBuffer.toFixed(1);
        this.downloadSpeedEl.innerText = stats.downloadSpeedMbps.toFixed(2);
        this.curQualityEl.innerText = stats.currentQuality;

        // Atualiza select se mudou automaticamente
        // (Isso pode ser melhorado para não interferir na interação do usuário)
        // const currentIdx = this.player.qualities.indexOf(stats.currentQuality);
        // if (currentIdx !== -1 && document.activeElement !== this.qualitySelect) {
        //     this.qualitySelect.value = currentIdx;
        // }
    }

    log(msg) {
        const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        this.logEl.innerText = line + '\n' + this.logEl.innerText;
    }
}
