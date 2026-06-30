export interface UIErrorData {
  title: string;
  advice: string;
}

export function mapErrorToUI(error: unknown): UIErrorData {
  const errMsg = error instanceof Error ? error.message : String(error);

  if (errMsg.includes('NO_NATIVE_HOST')) {
    return {
      title: 'Mute.ly Helper Not Installed',
      advice: `Run \`npm run install-host -- --extension-id=<ID>\` once from the project folder, then reload this page. Get the ID from chrome://extensions.\n\nDetails: ${errMsg}`
    };
  }

  if (errMsg.includes('NO_FFMPEG_OR_YTDLP')) {
    return {
      title: 'Missing yt-dlp or ffmpeg',
      advice: 'Install both on your system PATH: `brew install yt-dlp ffmpeg` (macOS), `sudo apt install yt-dlp ffmpeg` (Linux), or `winget install yt-dlp.yt-dlp ffmpeg` (Windows). Then re-run the installer.'
    };
  }

  if (errMsg.includes('NO_VIDEO')) {
    return {
      title: 'No Video Found',
      advice: 'Could not find a valid video on this page to transcribe.'
    };
  }

  if (errMsg.includes('NO_AUDIO_TRACK')) {
    return {
      title: 'No Audio Track',
      advice: 'Could not capture audio from this video. It may be DRM-protected or have no audio stream.'
    };
  }

  if (errMsg.includes('Permission denied') || errMsg.includes('Requested device not found')) {
    return {
      title: 'Microphone Access Denied',
      advice: 'Live extraction requires microphone permissions. Please allow access in your browser settings.'
    };
  }

  return {
    title: 'Unexpected Error',
    advice: 'An unexpected error occurred while starting the pipeline.'
  };
}
