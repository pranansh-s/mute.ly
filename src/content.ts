import { LiveStreamer } from './core/audio/live-streamer';
import { TranscriptionEngine } from './core/transcription/transcription-engine';
import { YouTubeDOM } from './core/youtube/youtube-dom';
import type { MonitorStatus } from './core/types';
import { PlayerButton } from './ui/player-button';
import { SubtitleOverlay } from './ui/subtitle-overlay';
import { ErrorOverlay } from './ui/error-overlay';
import { mapErrorToUI } from './core/errors/error-mapper';

class YouTubeMonitor {
  private readonly liveStreamer = new LiveStreamer();
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

  private mutationThrottleTimer: ReturnType<typeof setTimeout> | null = null;

  private initObserver() {
    const observer = new MutationObserver(() => {
      if (this.mutationThrottleTimer) return;
      this.mutationThrottleTimer = setTimeout(() => {
        this.mutationThrottleTimer = null;
        this.playerButton.checkAndInject();
        if (this.isRunning) {
          this.subtitleOverlay.checkAndInject();
          this.errorOverlay.checkAndInject();
        }
        this.scheduleNavigationCheck();
      }, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
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
      let engineErrorMessage: string | null = null;
      const engine = new TranscriptionEngine((committed, tentative) => {
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        this.subtitleOverlay.renderText(committed, tentative);
      });
      this.engine = engine;

      engine.onError = (message) => {
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        engineErrorMessage = message;
      };

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
          const { title, advice } = mapErrorToUI(new Error(engineErrorMessage ?? 'MODEL_LOAD_FAILED'));
          this.errorOverlay.showError(title, advice);
        }
      };

      engine.onLoadProgress = (progress) => {
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        this.subtitleOverlay.updateLoadingProgress(progress);
        this.playerButton.updateLoadingProgress(progress);
      };

      engine.onDeviceChange = (device) => {
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        this.subtitleOverlay.setDevice(device);
      };

      const isLive = YouTubeDOM.isLiveStream();
      const videoElement = YouTubeDOM.getVideoElement();
      const videoId = runVideoId;

      if (!isLive && videoId && videoElement) {
        engine.initialize('vod');
        const probe = await engine.probeHost();
        if (!this.isCurrentProcessingRun(generation, engine)) return;
        if (videoId !== this.currentVideoId) return;

        if (probe.ok) {
          this.subtitleOverlay.setMode('vod');
          engine.startAOT(videoId, videoElement);
        } else {
          this.setStatus('error');
          this.isRunning = false;
          engine.destroy();
          if (this.engine === engine) this.engine = null;
          const { title, advice } = mapErrorToUI(new Error(probe.reason || 'NO_NATIVE_HOST'));
          this.errorOverlay.showError(title, advice);
        }
      } else if (videoElement) {
        this.subtitleOverlay.setMode('live');
        engine.initialize('live');
        await this.liveStreamer.start(engine, videoElement);
      } else {
        throw new Error('NO_VIDEO');
      }
    } catch (error: unknown) {
      if (generation !== this.processingGeneration) return;
      const detail = error instanceof DOMException
        ? `DOMException ${error.name}: ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      console.error('[Mute.ly] Failed to start processing:', detail, error);
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
    await this.liveStreamer.stop();
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
    void this.stopMonitoring();
  };

  private handleNavigationEvent = () => {
    this.scheduleNavigationCheck();
  };

  private scheduleNavigationCheck() {
    if (this.navigationCheckTimer) return;
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
