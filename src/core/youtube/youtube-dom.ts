/**
 * Static utility methods for interacting with the YouTube DOM.
 */
export class YouTubeDOM {
  public static getVideoURL(): string | null {
    const match = window.location.href.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:\?|&|\/|$)/);
    return match ? match[1] : null;
  }

  public static isLiveStream(): boolean {
    const badge = document.querySelector('.ytp-live-badge');
    if (badge) {
      const style = window.getComputedStyle(badge);
      if (style.display !== 'none') return true;
    }
    const timeDisplay = document.querySelector('.ytp-time-display');
    return timeDisplay?.classList.contains('ytp-live') ?? false;
  }

  public static getVideoElement(): HTMLVideoElement | null {
    return document.querySelector('video') as HTMLVideoElement | null;
  }

  public static getPlayerContainer(): Element | null {
    return document.querySelector('.html5-video-player');
  }

  public static getControlsContainer(): Element | null {
    return document.querySelector('.ytp-right-controls');
  }
}
