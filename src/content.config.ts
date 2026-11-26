
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { slugifyTag } from './lib/tags';

const categoryTags = {
  'Operating Systems & Distributions': [
    'Arch Linux', 'Debian', 'Fedora', 'Ubuntu', 'openSUSE', 'Gentoo',
    'Void Linux', 'Slackware', 'Linux From Scratch', 'Alpine Linux',
    'NixOS', 'MX Linux', 'Linux Mint', 'elementary OS', 'FreeBSD',
    'OpenBSD', 'NetBSD', 'illumos', 'Tails', 'Qubes OS', 'Whonix',
    'PostmarketOS', 'Independent', 'Rolling Release', 'Point Release',
    'Server OS', 'Desktop OS', 'Mobile OS', 'Security-Focused', 'Live USB',
  ],
  'Audio Software': [
    'DAW', 'Audio Editor', 'Music Player', 'Audio Converter', 'Podcasting',
    'Music Notation', 'Synthesizer', 'Drum Machine', 'JACK', 'PipeWire',
    'LV2', 'LADSPA', 'FLAC', 'OGG', 'WAV', 'MP3',
  ],
  'Video Software': [
    'Video Editor', 'Media Player', 'Video Converter', 'Transcoder',
    'Media Server', 'Streaming', 'Screen Recorder', 'Subtitles', 'AV1',
    'H.264', 'H.265', 'MKV', 'MP4', 'Self-Hosted Video',
  ],
  'Image & Graphics': [
    'Raster Editor', 'Vector Editor', 'Photo Manager', 'Digital Painting',
    'RAW Processor', '3D Modeling', 'Image Converter', 'Color Management',
    'CMYK', 'PSD', 'SVG', 'Tablet Support',
  ],
  'Office & Productivity': [
    'Office Suite', 'Word Processor', 'Spreadsheet', 'Presentation',
    'Note-Taking', 'Notebook', 'Calendar', 'Task Manager',
    'Project Management', 'Kanban', 'Time Tracking', 'Markdown', 'Self-Hosted',
  ],
  'Development Tools': [
    'Code Editor', 'IDE', 'Version Control', 'Git', 'Code Hosting',
    'API Client', 'Terminal', 'Shell', 'LSP', 'Container', 'CI/CD',
    'Debugger', 'Static Site Generator',
  ],
  'System Utilities': [
    'Disk Management', 'Partition Editor', 'Data Recovery', 'Backup',
    'Disk Cleaner', 'System Monitor', 'Process Manager', 'File Manager',
    'Boot Loader', 'Package Manager', 'Live USB', 'Bare Metal Restore',
  ],
  'Security & Privacy': [
    'Password Manager', 'File Encryption', '2FA / Authenticator', 'VPN',
    'Tor', 'Anonymizing Network', 'Decentralized VPN', 'Metadata Removal',
    'Security Key', 'Whistleblower Tools', 'Audit', 'E2E Encryption',
    'Self-Hosted',
  ],
  'Internet & Web': [
    'Web Browser', 'Browser Extension', 'Email Client', 'Messaging',
    'Torrent Client', 'DNS', 'Search Engine', 'Ad Blocking', 'Web Fonts',
    'Firefox Extension', 'Chrome Extension', 'Safari Extension',
    'Federation', 'Matrix', 'XMPP',
  ],
  'Communication & Collaboration': [
    'Team Chat', 'Email Service', 'Blogging', 'Social Network', 'Comments',
    'Forms', 'RSS Reader', 'ActivityPub', 'Federation', 'Decentralized',
    'E2E Encryption', 'Self-Hosted',
  ],
  'Design & Engineering (CAD / CAM / EDA)': [
    'CAD', 'CAM', 'EDA', '3D Modeling', 'PCB Design', 'Slicer', 'CNC',
    'Simulation', 'Parametric Modeling', 'STEP', 'IGES', 'Gerber',
    'G-code', 'FDM', 'CFD',
  ],
  'Finance & Crypto': [
    'Personal Finance', 'Accounting', 'Bitcoin Wallet', 'Monero Wallet',
    'Hardware Wallet', 'Plain-Text Accounting', 'Self-Hosted', 'Full Node',
    'Self-Custody', 'OpenPGP', 'Trezor', 'Ledger',
  ],
  'Cloud & Self-Hosting': [
    'Cloud Storage', 'File Sync', 'Hosting Panel', 'Web Analytics',
    'Pastebin', 'Photo Storage', 'Self-Hosted', 'Docker', 'Ansible',
    'ARM Support', 'Migration',
  ],
  'Mobile & Smart Devices': [
    'Android Browser', 'Android Keyboard', 'App Store', 'Router Firmware',
    'Smart Home', 'Phone', 'De-Googled', 'Mobile OS', 'Custom ROM',
    'F-Droid', 'Signed Builds', 'Hardware Compatibility',
  ],
  'Miscellaneous': [
    'Translation', 'Maps', 'Health & Fitness', 'CAPTCHA', 'API Client',
    'Fonts', 'Utilities', 'Self-Hosted',
  ],
} as const;

const blog = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum([
      'Operating Systems & Distributions',
      'Audio Software',
      'Video Software',
      'Image & Graphics',
      'Office & Productivity',
      'Development Tools',
      'System Utilities',
      'Security & Privacy',
      'Internet & Web',
      'Communication & Collaboration',
      'Design & Engineering (CAD / CAM / EDA)',
      'Finance & Crypto',
      'Cloud & Self-Hosting',
      'Mobile & Smart Devices',
      'Miscellaneous',
    ]),
    date: z.coerce.date(),
    // Tags with the same slug share an archive page, so keep the first spelling.
    tags: z.array(z.string()).default([]).transform(tags => {
      const slugs = tags.map(slugifyTag);
      return tags.filter((_, index) => slugs.indexOf(slugs[index]) === index);
    }),
    draft: z.boolean().default(false),
  }).superRefine((data, ctx) => {
    const allowedTags = categoryTags[data.category] as readonly string[];

    data.tags.forEach((tag, index) => {
      if (!allowedTags.includes(tag)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tags', index],
          message: `Tag "${tag}" is not allowed for category "${data.category}".`,
        });
      }
    });
  }),
});

export const collections = { blog };
