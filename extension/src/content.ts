import { AudioExtractor } from './lib/audio-extractor';
import { TransportClient } from './lib/transport';
import type { MonitorStatus } from './lib/types';
import { PlayerButton } from './ui/player-button';
import { SubtitleOverlay } from './ui/subtitle-overlay';

const BACKEND_WS_URL = 'ws://localhost:3001/ws';

class YouTubeMonitor {
  private readonly audioExtractor: AudioExtractor;
  private transport: TransportClient | null = null;

  private status: MonitorStatus = 'idle';
  private isRunning = false;

  private currentVideoId: string | null = null;
  private playerButton: PlayerButton;
  private subtitleOverlay: SubtitleOverlay;

  constructor() {
    this.audioExtractor = new AudioExtractor();

    this.subtitleOverlay = new SubtitleOverlay();
    this.playerButton = new PlayerButton(() => this.toggleMonitoring());

    this.currentVideoId = this.getVideoURL();
    this.initObserver();
  }

  private initObserver() {
    const observer = new MutationObserver(async () => {
      const videoId = this.getVideoURL();

      if (videoId && videoId !== this.currentVideoId) {
        this.currentVideoId = videoId;

        if (this.isRunning) {
          this.setStatus('idle');
          await this.stopProcessing();
          await this.startProcessing();
        }
        this.subtitleOverlay.clear();
      } else if (!videoId && this.currentVideoId) {
        this.currentVideoId = null;
        if (this.isRunning) {
          await this.stopMonitoring();
        }
        this.subtitleOverlay.destroy();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  private getVideoURL(): string | null {
    const url = window.location.href;
    const match = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:\?|&|\/|$)/);
    return match ? match[1] : null;
  }

  public toggleMonitoring = () => {
    if (this.isRunning) {
      this.stopMonitoring();
    } else {
      this.startMonitoring();
    }
  }

  public async startMonitoring(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.setStatus('audio');
    this.subtitleOverlay.clear();

    if (!this.currentVideoId) {
      this.currentVideoId = this.getVideoURL();
    }

    if (!this.currentVideoId) {
      this.setStatus('error');
      this.isRunning = false;
      return;
    }

    await this.startProcessing();
  }

  public async stopMonitoring(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    this.setStatus('idle');
    await this.stopProcessing();
    this.subtitleOverlay.clear();
  }

  private async startProcessing(): Promise<void> {
    try {
      this.transport = new TransportClient();

      this.transport.onStatusChange = (connected) => {
        if (!this.isRunning) return;
        this.setStatus(connected ? 'audio' : 'error');
      };

      const timeDisplay = document.querySelector('.ytp-time-display');
      const isLive = timeDisplay ? timeDisplay.classList.contains('ytp-live') : false;

      this.transport.connect(BACKEND_WS_URL, this.currentVideoId!, isLive, (text, isPartial) => {
        this.subtitleOverlay.renderText(text, isPartial);
      });

      await this.audioExtractor.startExtraction(this.transport!, isLive);
    } catch (error) {
      console.error('[Mute.ly] Failed to start STT processing:', error);
      this.setStatus('error');
    }
  }

  private async stopProcessing() {
    await this.audioExtractor.stopExtraction();
    if (this.transport) {
      this.transport.disconnect();
      this.transport = null;
    }
  }

  private setStatus(newStatus: MonitorStatus) {
    this.status = newStatus;
    this.playerButton.updateState(this.status);
  }

}

const monitor = new YouTubeMonitor();