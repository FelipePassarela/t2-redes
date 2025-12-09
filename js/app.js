import { DashPlayer } from "./DashPlayer.js";
import { UIController } from "./UIController.js";

const videoElement = document.getElementById("videoPlayer");
const baseURL = "http://localhost:8080/dash/";
const ui = new UIController();
const player = new DashPlayer(videoElement, baseURL, ui);
