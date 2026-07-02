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

  if (errMsg.includes('AOT_TAKEOVER')) {
    return {
      title: 'Captions Stopped',
      advice: 'Captions were started in another tab. Click the Mute.ly button here to take them back.'
    };
  }

  if (errMsg.includes('PCM_GAP')) {
    return {
      title: 'Audio Stream Interrupted',
      advice: 'The audio download was interrupted. Click the Mute.ly button to restart captions.'
    };
  }

  if (errMsg.includes('MODEL_LOAD_FAILED') || errMsg.includes('Model load') || errMsg.includes('Worker crash')) {
    return {
      title: 'Model Load Failed',
      advice: 'The transcription engine could not be initialized. Check your connection and click the Mute.ly button to retry.'
    };
  }

  if (errMsg.includes('Permission denied') || errMsg.includes('Requested device not found')) {
    return {
      title: 'Audio Capture Blocked',
      advice: 'Could not capture the video\'s audio stream. Reload the page and try again.'
    };
  }

  return {
    title: 'Unexpected Error',
    advice: 'An unexpected error occurred while starting the pipeline.'
  };
}
