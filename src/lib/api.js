const { spawn } = require('child_process');
const { Transform } = require('stream');
const path = require('path');

const EventEmitter = require('events');
const queueEvent = new EventEmitter();

import db from './db.js';
import State from './state.js';
import store from '../store.js';

const isDevelopment = process.env.NODE_ENV !== 'production';

const ytdlPath = isDevelopment
  ? path.join(process.cwd(), 'dev', 'resources', 'youtube-dl')
  : path.join(process.cwd(), 'resources', 'youtube-dl');

const ffmpegPath = isDevelopment
  ? path.join(process.cwd(), 'dev', 'resources', 'ffmpeg')
  : path.join(process.cwd(), 'resources', 'ffmpeg');

const active = new Map();
let queue = [];

function fetchInfo(links) {
  const args = [
    '--all-subs',
    '--dump-json',
    '--no-playlist',
    '--ignore-errors'
  ];
  const child = spawn(ytdlPath, [...args, ...links]);

  const tStream = new Transform({
    readableObjectMode: true,
    transform(chunk, encoding, callback) {
      this.push(createDownloadable(chunk.toString()));
      callback();
    }
  });

  return child.stdout.pipe(tStream);
}

function createDownloadable(data) {
  const metadata = JSON.parse(data);
  const {
    webpage_url,
    title,
    thumbnail,
    duration,
    formats,
    requested_subtitles,
    playlist,
    playlist_title,
    playlist_index,
    n_entries
  } = metadata;

  const newFormats = getFormats(formats || metadata.format_id);
  const formatIndex = newFormats.findIndex(x => x.isAudioOnly === false);

  const downloadable = {
    url: webpage_url,
    title: title,
    thumbnail: thumbnail,
    duration: getDuration(duration),
    formats: newFormats,
    formatIndex: formatIndex,
    state: State.STOPPED,
    progress: null,
    subtitles: getSubtitles(requested_subtitles),
    playlist: {
      exists: !!playlist,
      title: playlist_title,
      index: playlist_index,
      count: n_entries
    },
    filepath: null
  };
  return downloadable;
}

function getFormats(data) {
  if (!Array.isArray(data)) {
    return [
      {
        isAudioOnly: false,
        quality: data,
        suffix: '',
        code: data
      }
    ];
  }

  let formats = [];
  let seen = new Set();

  data.forEach(format => {
    const { acodec, vcodec, abr, width, height, format_id } = format;
    const isAudioOnly =
      height == undefined && width == undefined && abr != undefined;
    const isVideoOnly = vcodec !== 'none' && acodec === 'none';

    const quality = isAudioOnly ? abr : height || format_id;
    const suffix = isAudioOnly
      ? 'kbps'
      : isVideoOnly
      ? 'p'
      : Number.isInteger(quality)
      ? 'p'
      : '';
    const code = isAudioOnly
      ? `bestaudio[abr<=${abr}]`
      : isVideoOnly
      ? `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
      : format_id;

    const key = (isAudioOnly ? 'a' : 'v') + quality;
    if (quality && !seen.has(key)) {
      formats.push({ isAudioOnly, quality, suffix, code });
      seen.add(key);
    }
  });

  const compare = (x, y) => {
    const a = parseInt(x.quality);
    const b = parseInt(y.quality);

    if (!isNaN(a) && !isNaN(b)) {
      // If both a and b are numbers, the larger one comes first
      return b - a;
    } else if (!isNaN(a)) {
      // If a is number but b is not, b comes first
      return 1;
    } else if (!isNaN(b)) {
      // If b is a number but a is not, a comes first
      return -1;
    }
    // If neither a nor b are numbers, leave unchanged
    return 0;
  };

  formats.sort(compare);
  return formats;
}

function getSubtitles(subtitles) {
  return subtitles === null ? [] : Object.keys(subtitles);
}

function getDuration(duration) {
  const total = Math.floor(duration || 0);
  if (total === 0) return '-';

  const pad = num => String(num).padStart(2, '0');

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = (total % 3600) % 60;

  if (hours !== 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  else if (minutes !== 0) return `${pad(minutes)}:${pad(seconds)}`;
  else return `0:${pad(seconds)}`;
}

function download({ url, format, playlist }) {
  if (active.size >= db.get('simultaneous')) {
    queue.push(url);
    return null;
  }

  const args = generateArgs({ url, format, playlist });
  const child = spawn(ytdlPath, args);

  active.set(url, child.pid);

  const tStream = new Transform({
    readableObjectMode: true,
    transform(chunk, encoding, callback) {
      this.push(getProgress(chunk.toString()));
      callback();
    }
  });

  child.stdout.on('end', () => {
    active.delete(url);
    queueEvent.emit('dequeue', queue.shift());
  });

  return child.stdout.pipe(tStream);
}

function generateArgs({ url, format, playlist }) {
  let args = [
    '--ffmpeg-location',
    ffmpegPath,
    '-f',
    format.code,
    '-o',
    getOutputFormat({ url, playlist })
  ];
  args.push(...getAVOptions(format.isAudioOnly));

  if (db.get('ascii')) {
    args.push('--restrict-filenames');
  }

  args.push(url);

  return args;
}

function getAVOptions(isAudio) {
  const index = db.get(isAudio ? 'audioIndex' : 'videoIndex');
  const format = db.get(isAudio ? 'audioFormats' : 'videoFormats')[index];

  const options = isAudio
    ? ['--extract-audio', '--audio-format', format]
    : ['--recode-video', format];

  return format === 'default' ? [] : options;
}

function getOutputFormat({ url, playlist }) {
  const index = db.get('filenameIndex');
  let format = db.get('filenameFormats')[index].key;

  if (playlist.exists) {
    if (db.get('autonumber')) {
      const separator = db.get('ascii') ? '_' : ' - ';
      format = playlist.index + separator + format;
    }
    format = path.join(playlist.title, format);
  }

  const filepath = playlist.exists
    ? path.join(db.get('downloadLocation'), playlist.title, '*')
    : path.join(db.get('downloadLocation'), '*');

  store.dispatch('updateFilepath', { url, filepath });

  return path.join(db.get('downloadLocation'), format);
}

function getProgress(data) {
  const regex = /(?<percent>\d+\.\d+)\D+(?<size>\d+\.\d+)(?<unit>\w+)\D+(?<speed>\d+\.\d+\w+\/s)\D+(?<eta>[\d:]+)/;
  const match = regex.exec(data);

  if (match) {
    const { percent, size, unit, speed, eta } = match.groups;
    const progress = {
      percent: percent,
      downloaded: ((percent / 100) * size).toFixed(2),
      size: size + unit,
      speed: speed,
      eta: getETA(eta)
    };
    return progress;
  } else if (data.includes('[ffmpeg]')) {
    return 'processing';
  }
  return '';
}

function getETA(eta) {
  const hRegex = /(?<hr>\d+):(?<min>\d+):(?<sec>\d+)/;
  const mRegex = /(?<min>\d+):(?<sec>\d+)/;
  let { hr, min, sec } = (hRegex.exec(eta) || mRegex.exec(eta)).groups;

  hr = hr ? Number(hr) : 0;
  min = Number(min);
  sec = Number(sec);

  return hr !== 0
    ? `${min >= 30 ? hr + 1 : hr}h left`
    : min !== 0
    ? `${sec >= 30 ? min + 1 : min}min left`
    : `${sec + 1}s left`;
}

function pause(url) {
  // If queued, remove from queue
  const index = queue.indexOf(url);
  if (index !== -1) queue.splice(index, 1);
  // If active, kill process
  const pid = active.get(url);
  if (pid) process.kill(pid);
}

export default { fetchInfo, download, pause, queueEvent };
