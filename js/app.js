import { DashPlayer } from './dash-player.js';

// Init
const player = new DashPlayer(document.getElementById('videoPlayer'));
document.getElementById('btnLoad').addEventListener('click', () => player.loadManifest());
