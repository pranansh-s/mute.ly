export class PlayerButton {
  private buttonElement: HTMLButtonElement | null = null;
  private currentStatus: 'idle' | 'audio' | 'error' = 'idle';

  private toggleCallback: () => void;

  constructor(onToggle: () => void) {
    this.toggleCallback = onToggle;

    const observer = new MutationObserver(this.inject);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  private inject = () => {
    if (this.buttonElement && document.body.contains(this.buttonElement)) {
      return;
    }

    const container = document.querySelector('.ytp-right-controls');
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

  public updateState(status: 'idle' | 'audio' | 'error') {
    this.currentStatus = status;
    if (!this.buttonElement) return;

    const path = this.buttonElement.querySelector('.mutely-svg-path') as SVGPathElement;
    if (!path) return;

    if (status === 'audio') {
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
}
