import { YouTubeDOM } from '../core/youtube/youtube-dom';
import {
  BASE_CONTAINER_STYLE,
  ERROR_MODAL_STYLE,
  ERROR_TITLE_STYLE,
  ERROR_ADVICE_STYLE,
  ERROR_RETRY_STYLE
} from './overlay-styles';

export class ErrorOverlay {
  private container: HTMLDivElement | null = null;
  private errorElement: HTMLDivElement | null = null;

  constructor() {
    this.checkAndInject();
  }

  public checkAndInject = () => {
    if (this.container && document.body.contains(this.container)) return;
    if (this.container) this.destroy();

    const playerContainer = YouTubeDOM.getPlayerContainer();
    if (!playerContainer) return;

    this.container = document.createElement('div');
    this.container.id = 'mutely-error-container';

    Object.assign(this.container.style, {
      ...BASE_CONTAINER_STYLE,
      bottom: '20%',
      zIndex: '10000',
    });

    playerContainer.appendChild(this.container);
  }

  public showError(title: string, advice?: string) {
    this.checkAndInject();
    if (!this.container) return;

    this.clear();

    this.errorElement = document.createElement('div');
    this.errorElement.id = 'mutely-error-indicator';
    Object.assign(this.errorElement.style, ERROR_MODAL_STYLE);

    const titleEl = document.createElement('div');
    Object.assign(titleEl.style, ERROR_TITLE_STYLE);
    titleEl.textContent = `Mute.ly: ${title}`;
    this.errorElement.appendChild(titleEl);

    if (advice) {
      const adviceEl = document.createElement('div');
      Object.assign(adviceEl.style, ERROR_ADVICE_STYLE);
      adviceEl.textContent = advice;
      this.errorElement.appendChild(adviceEl);
    }

    const retryEl = document.createElement('div');
    Object.assign(retryEl.style, ERROR_RETRY_STYLE);
    retryEl.textContent = 'Click the Mute.ly button to retry';
    this.errorElement.appendChild(retryEl);

    this.container.appendChild(this.errorElement);
    this.container.style.opacity = '1';
  }

  public clear() {
    if (this.errorElement) {
      this.errorElement.remove();
      this.errorElement = null;
    }
    if (this.container) {
      this.container.style.opacity = '0';
    }
  }

  destroy() {
    this.clear();
    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }
}
