import { AudioExtractor } from './core/audio/audio-extractor';
import { TranscriptionEngine } from './core/transcription/transcription-engine';
import { YouTubeDOM } from './core/youtube/youtube-dom';
import type { MonitorStatus } from './core/types';
import { PlayerButton } from './ui/player-button';
import { SubtitleOverlay } from './ui/subtitle-overlay';
import { ErrorOverlay } from './ui/error-overlay';
import { mapErrorToUI } from './core/errors/error-mapper';

const LOCAL_SERVER_URL = 'http://localhost:3000';

class YouTubeMonitor {
  private readonly audioExtractor = new AudioExtractor();
  private engine: TranscriptionEngine | null = null;
  private isRunning = false;
  private isStartingPipeline = false;
  private currentVideoId: string | null = null;
  private playerButton: PlayerButton;
  private subtitleOverlay: SubtitleOverlay;
  private errorOverlay: ErrorOverlay;

  constructor() {
    this.subtitleOverlay = new SubtitleOverlay();
    this.errorOverlay = new ErrorOverlay();
    this.playerButton = new PlayerButton(() => this.toggleMonitoring());
    this.currentVideoId = YouTubeDOM.getVideoURL();
    this.initObserver();
  }

  private initObserver() {
    const observer = new MutationObserver(async () => {
      this.playerButton.checkAndInject();
      if (this.isRunning) {
        this.subtitleOverlay.checkAndInject();
        this.errorOverlay.checkAndInject();
      }

      const videoId = YouTubeDOM.getVideoURL();

      if (videoId && videoId !== this.currentVideoId) {
        this.currentVideoId = videoId;
        if (this.isRunning && !this.isStartingPipeline) {
          this.isStartingPipeline = true;
          this.setStatus('idle');
          await this.stopProcessing();
          this.isStartingPipeline = false;
          await this.startProcessing();
        }
        this.subtitleOverlay.clear();
        this.errorOverlay.clear();
      } else if (!videoId && this.currentVideoId) {
        this.currentVideoId = null;
        if (this.isRunning) await this.stopMonitoring();
        this.subtitleOverlay.destroy();
        this.errorOverlay.destroy();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  private async checkServerHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${LOCAL_SERVER_URL}/api/health`);
      return res.ok;
    } catch (err) {
      console.error('[Mute.ly] Local server unreachable. Is it running? (npm run server)', err);
      return false;
    }
  }

  public toggleMonitoring = () => {
    if (this.isRunning) {
      this.stopMonitoring();
    } else {
      this.startMonitoring();
    }
  };

  public async startMonitoring(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.setStatus('loading');
    this.subtitleOverlay.clear();
    this.errorOverlay.clear();

    if (!this.currentVideoId) this.currentVideoId = YouTubeDOM.getVideoURL();
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
    this.errorOverlay.clear();
  }

  private async startProcessing(): Promise<void> {
    if (this.isStartingPipeline) return;
    this.isStartingPipeline = true;
    console.log('[Monitor] Starting processing...');

    try {
      this.engine = new TranscriptionEngine((text, isPartial) => {
        this.subtitleOverlay.renderText(text, isPartial);
      });

      this.engine.onStatusChange = (status) => {
        if (!this.isRunning) return;
        if (status === 'ready') {
          this.setStatus('audio');
          this.subtitleOverlay.hideLoading();
        } else if (status === 'loading') {
          this.setStatus('loading');
          this.subtitleOverlay.showLoading();
        } else if (status === 'error') {
          this.setStatus('error');
          this.errorOverlay.showError('Model Load Failed', 'The transcription engine could not be initialized.');
        }
      };

      this.engine.onLoadProgress = (progress) => {
        this.subtitleOverlay.updateLoadingProgress(progress);
        this.playerButton.updateLoadingProgress(progress);
      };

      this.engine.initialize();

      const isLive = YouTubeDOM.isLiveStream();
      const videoElement = YouTubeDOM.getVideoElement();

      if (!isLive && this.currentVideoId && videoElement) {
        // VOD Pipeline: verify server is running, then start AOT with static proxy URL
        const isServerUp = await this.checkServerHealth();
        if (isServerUp) {
          this.subtitleOverlay.setMode('vod');
          const audioUrl = `${LOCAL_SERVER_URL}/api/audio-proxy?videoId=${this.currentVideoId}`;
          this.engine.startAOT(audioUrl, videoElement);
        } else {
          this.setStatus('error');
          this.errorOverlay.showError('Server Unreachable', 'Ensure "npm run server" is running in the mute.ly directory.');
        }
      } else if (videoElement) {
        // Live Pipeline: real-time transcription via captureStream
        this.subtitleOverlay.setMode('live');
        await this.audioExtractor.startExtraction(this.engine, videoElement);
      } else {
        throw new Error('NO_VIDEO');
      }
    } catch (error: unknown) {
      console.error('[Mute.ly] Failed to start processing:', error);
      this.setStatus('error');
      
      const { title, advice } = mapErrorToUI(error);
      this.errorOverlay.showError(title, advice);
    } finally {
      this.isStartingPipeline = false;
    }
  }

  private async stopProcessing() {
    this.isStartingPipeline = false;
    await this.audioExtractor.stopExtraction();
    if (this.engine) {
      this.engine.destroy();
      this.engine = null;
    }
  }

  private setStatus(status: MonitorStatus) {
    this.playerButton.updateState(status);
  }
}

if (!(window as any).__MUTE_LY_INJECTED) {
  (window as any).__MUTE_LY_INJECTED = true;
  new YouTubeMonitor();
}