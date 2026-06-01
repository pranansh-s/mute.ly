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
  private processingGeneration = 0;
  private currentVideoId: string | null = null;
  private currentUrl = window.location.href;
  private navigationCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private playerButton: PlayerButton;
  private subtitleOverlay: SubtitleOverlay;
  private errorOverlay: ErrorOverlay;

  constructor() {
    this.subtitleOverlay = new SubtitleOverlay();
    this.errorOverlay = new ErrorOverlay();
    this.playerButton = new PlayerButton(() => this.toggleMonitoring());
    this.currentVideoId = YouTubeDOM.getVideoURL();
    this.initObserver();
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('popstate', this.handleNavigationEvent);
    document.addEventListener('yt-navigate-finish', this.handleNavigationEvent);
    document.addEventListener('yt-page-data-updated', this.handleNavigationEvent);
  }

  private initObserver() {
    const observer = new MutationObserver(async () => {
      this.playerButton.checkAndInject();
      if (this.isRunning) {
        this.subtitleOverlay.checkAndInject();
        this.errorOverlay.checkAndInject();
      }

      this.scheduleNavigationCheck();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  private async checkServerHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${LOCAL_SERVER_URL}/api/health`);
      return res.ok;
    } catch {
      console.error('[Mute.ly] Local server unreachable. Is it running? (npm run server)');
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
    const generation = ++this.processingGeneration;
    const runVideoId = this.currentVideoId;

    try {
      const engine = new TranscriptionEngine((text, isPartial) => {
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        this.subtitleOverlay.renderText(text, isPartial);
      });
      this.engine = engine;

      engine.onStatusChange = (status) => {
        if (!this.isRunning || !this.isCurrentProcessingRun(generation, engine)) return;
        if (status === 'ready') {
          this.setStatus('audio');
          this.subtitleOverlay.hideLoading();
        } else if (status === 'loading') {
          this.setStatus('loading');
          this.subtitleOverlay.showLoading();
        } else if (status === 'error') {
          this.setStatus('error');
          this.isRunning = false;
          engine.destroy();
          if (this.engine === engine) this.engine = null;
          this.errorOverlay.showError('Model Load Failed', 'The transcription engine could not be initialized.');
        }
      };

      engine.onLoadProgress = (progress) => {
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        this.subtitleOverlay.updateLoadingProgress(progress);
        this.playerButton.updateLoadingProgress(progress);
      };

      const isLive = YouTubeDOM.isLiveStream();
      const videoElement = YouTubeDOM.getVideoElement();
      const videoId = runVideoId;

      if (!isLive && videoId && videoElement) {
        engine.initialize('base');
        const isServerUp = await this.checkServerHealth();
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        if (videoId !== this.currentVideoId) return;

        if (isServerUp) {
          this.subtitleOverlay.setMode('vod');
          const audioUrl = `${LOCAL_SERVER_URL}/api/audio-proxy?videoId=${videoId}`;
          engine.startAOT(audioUrl, videoElement);
        } else {
          this.setStatus('error');
          this.isRunning = false;
          engine.destroy();
          if (this.engine === engine) this.engine = null;
          this.errorOverlay.showError('Server Unreachable', 'Ensure "npm run server" is running in the mute.ly directory.');
        }
      } else if (videoElement) {
        this.subtitleOverlay.setMode('live');
        engine.initialize('tiny');
        await this.audioExtractor.startExtraction(engine, videoElement);
      } else {
        throw new Error('NO_VIDEO');
      }
    } catch (error: unknown) {
      if (generation !== this.processingGeneration) return;
      console.error('[Mute.ly] Failed to start processing:', error);
      this.setStatus('error');
      this.isRunning = false;
      if (this.engine) {
        this.engine.destroy();
        this.engine = null;
      }
      
      const { title, advice } = mapErrorToUI(error);
      this.errorOverlay.showError(title, advice);
    } finally {
      if (generation === this.processingGeneration) {
        this.isStartingPipeline = false;
        if (this.isRunning && runVideoId !== this.currentVideoId) {
          await this.stopProcessing();
          await this.startProcessing();
        }
      }
    }
  }

  private async stopProcessing() {
    this.processingGeneration++;
    this.isStartingPipeline = false;
    this.clearNavigationCheck();
    await this.audioExtractor.stopExtraction();
    if (this.engine) {
      this.engine.destroy();
      this.engine = null;
    }
  }

  private setStatus(status: MonitorStatus) {
    this.playerButton.updateState(status);
  }

  private isCurrentProcessingRun(generation: number, engine: TranscriptionEngine) {
    return generation === this.processingGeneration && this.engine === engine;
  }

  private handlePageHide = () => {
    this.setStatus('idle');
    this.subtitleOverlay.clear();
    this.errorOverlay.clear();
    void this.stopMonitoring();
  };

  private handleNavigationEvent = () => {
    this.scheduleNavigationCheck();
  };

  private scheduleNavigationCheck() {
    this.clearNavigationCheck();
    this.navigationCheckTimer = setTimeout(() => {
      this.navigationCheckTimer = null;
      void this.reconcileNavigationState();
    }, 100);
  }

  private clearNavigationCheck() {
    if (!this.navigationCheckTimer) return;
    clearTimeout(this.navigationCheckTimer);
    this.navigationCheckTimer = null;
  }

  private async reconcileNavigationState() {
    const nextUrl = window.location.href;
    const nextVideoId = YouTubeDOM.getVideoURL();
    const urlChanged = nextUrl !== this.currentUrl;
    const videoChanged = nextVideoId !== this.currentVideoId;

    if (!urlChanged && !videoChanged) return;

    this.currentUrl = nextUrl;

    if (!nextVideoId) {
      this.currentVideoId = null;
      if (this.isRunning) {
        await this.stopMonitoring();
      } else {
        this.setStatus('idle');
      }
      this.subtitleOverlay.destroy();
      this.errorOverlay.destroy();
      return;
    }

    if (!videoChanged) {
      this.playerButton.checkAndInject();
      if (this.isRunning) this.subtitleOverlay.checkAndInject();
      return;
    }

    this.currentVideoId = nextVideoId;
    this.subtitleOverlay.clear();
    this.errorOverlay.clear();

    if (!this.isRunning) {
      this.setStatus('idle');
      return;
    }

    this.setStatus('loading');
    await this.stopProcessing();
    await this.startProcessing();
  }
}

if (!(window as any).__MUTE_LY_INJECTED) {
  (window as any).__MUTE_LY_INJECTED = true;
  new YouTubeMonitor();
}
