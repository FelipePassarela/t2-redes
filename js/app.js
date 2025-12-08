import { DashPlayer } from "./DashPlayer.js";

const videoElement = document.getElementById("videoPlayer");
const baseURL = "http://localhost:8080/dash/";
const player = new DashPlayer(videoElement, baseURL);
