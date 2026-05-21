import { YouTubeDOM } from '../core/youtube/youtube-dom';
import type { MonitorStatus } from '../core/types';

export class PlayerButton {
  private buttonElement: HTMLButtonElement | null = null;
  private currentStatus: MonitorStatus = 'idle';
  private loadingProgress = 0;

  private toggleCallback: () => void;

  constructor(onToggle: () => void) {
    this.toggleCallback = onToggle;
  }

  public checkAndInject = () => {
    if (this.buttonElement && document.body.contains(this.buttonElement)) {
      return;
    }

    const container = YouTubeDOM.getControlsContainer();
    if (!container) return;

    this.buttonElement = document.createElement('button');
    this.buttonElement.id = 'mutely-player-button';
    this.buttonElement.className = 'ytp-button';
    this.buttonElement.setAttribute('aria-label', 'Mute.ly Captions');
    this.buttonElement.setAttribute('title', 'Mute.ly Captions');

    Object.assign(this.buttonElement.style, {
      opacity: '0.8',
      transition: 'opacity 0.1s',
      display: 'flex',
      alignItems: 'center',
      width: '100%',
    });

    this.buttonElement.innerHTML = `
      <svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%" xmlns="http://www.w3.org/2000/svg">
        <path class="mutely-svg-path" d="M11,14 L11,22 L15,22 L20,27 L20,9 L15,14 L11,14 Z M22,15.5 L22,20.5 C23.5,19.8 24.5,18.3 24.5,18 C24.5,17.7 23.5,16.2 22,15.5 Z" fill="#ffffff"></path>
      </svg>
    `;

    this.buttonElement.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCallback();
    });

    this.buttonElement.addEventListener('mouseenter', () => {
      this.buttonElement!.style.opacity = '1';
    });

    this.buttonElement.addEventListener('mouseleave', () => {
      if (this.buttonElement && this.buttonElement.getAttribute('data-active') !== 'true') {
        this.buttonElement.style.opacity = '0.8';
      }
    });

    container.insertBefore(this.buttonElement, container.firstChild);
    this.updateState(this.currentStatus);
  }

  public updateLoadingProgress(progress: number) {
    this.loadingProgress = progress;
    if (this.currentStatus === 'loading' && this.buttonElement) {
      this.buttonElement.setAttribute('title', `Mute.ly Loading model... ${progress}%`);
    }
  }

  public updateState(status: MonitorStatus) {
    this.currentStatus = status;
    if (!this.buttonElement) return;

    const path = this.buttonElement.querySelector('.mutely-svg-path') as SVGPathElement;
    if (!path) return;

    this.buttonElement.style.animation = '';

    if (status === 'loading') {
      path.setAttribute('fill', '#ffa726');
      this.buttonElement.setAttribute('data-active', 'true');
      this.buttonElement.style.opacity = '1';
      this.buttonElement.style.animation = 'mutely-pulse 1.5s ease-in-out infinite';
      this.buttonElement.setAttribute('title', `Mute.ly Loading model... ${this.loadingProgress}%`);
      this.injectPulseAnimation();
    } else if (status === 'audio') {
      path.setAttribute('fill', '#ff4081');
      this.buttonElement.setAttribute('data-active', 'true');
      this.buttonElement.style.opacity = '1';
      this.buttonElement.setAttribute('title', 'Mute.ly Active - Click to stop');
    } else if (status === 'error') {
      path.setAttribute('fill', '#ff0000');
      this.buttonElement.setAttribute('data-active', 'false');
      this.buttonElement.style.opacity = '1';
      this.buttonElement.setAttribute('title', 'Mute.ly Error - Click to retry');
    } else {
      path.setAttribute('fill', '#ffffff');
      this.buttonElement.setAttribute('data-active', 'false');
      this.buttonElement.style.opacity = '0.8';
      this.buttonElement.setAttribute('title', 'Mute.ly Captions');
    }
  }

  private injectPulseAnimation() {
    if (document.getElementById('mutely-pulse-style')) return;
    const style = document.createElement('style');
    style.id = 'mutely-pulse-style';
    style.textContent = `
      @keyframes mutely-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `;
    document.head.appendChild(style);
  }
}
