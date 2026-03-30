// === PixelIcons — Lucide SVG icon system for pixel-agents dashboard ===
// Replaces emoji HTML entities with crisp inline SVGs.
// Exposes: window.PixelIcons.icon(name, size?) → SVG string
// Source: Lucide (https://lucide.dev) — MIT licensed

(function () {
  'use strict';

  // ── Inject icon baseline CSS ──
  var style = document.createElement('style');
  style.id = 'pixel-icons-styles';
  style.textContent =
    '.icon {' +
      'display: inline-flex;' +
      'align-items: center;' +
      'justify-content: center;' +
      'vertical-align: middle;' +
      'flex-shrink: 0;' +
    '}';
  document.head.appendChild(style);

  // ── SVG path data (inner content only, no wrapping <svg> tag) ──
  var ICONS = {
    'play':
      '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />',

    'pause':
      '<rect x="14" y="3" width="5" height="18" rx="1" />' +
      '<rect x="5" y="3" width="5" height="18" rx="1" />',

    'square':
      '<rect width="18" height="18" x="3" y="3" rx="2" />',

    'volume-2':
      '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />' +
      '<path d="M16 9a5 5 0 0 1 0 6" />' +
      '<path d="M19.364 18.364a9 9 0 0 0 0-12.728" />',

    'dice-5':
      '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" />' +
      '<path d="M16 8h.01" />' +
      '<path d="M8 8h.01" />' +
      '<path d="M8 16h.01" />' +
      '<path d="M16 16h.01" />' +
      '<path d="M12 12h.01" />',

    'history':
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />' +
      '<path d="M3 3v5h5" />' +
      '<path d="M12 7v5l4 2" />',

    'hash':
      '<line x1="4" x2="20" y1="9" y2="9" />' +
      '<line x1="4" x2="20" y1="15" y2="15" />' +
      '<line x1="10" x2="8" y1="3" y2="21" />' +
      '<line x1="16" x2="14" y1="3" y2="21" />',

    'x':
      '<path d="M18 6 6 18" />' +
      '<path d="m6 6 12 12" />',

    'maximize':
      '<path d="M8 3H5a2 2 0 0 0-2 2v3" />' +
      '<path d="M21 8V5a2 2 0 0 0-2-2h-3" />' +
      '<path d="M3 16v3a2 2 0 0 0 2 2h3" />' +
      '<path d="M16 21h3a2 2 0 0 0 2-2v-3" />',

    'minimize':
      '<path d="M8 3v3a2 2 0 0 1-2 2H3" />' +
      '<path d="M21 8h-3a2 2 0 0 1-2-2V3" />' +
      '<path d="M3 16h3a2 2 0 0 1 2 2v3" />' +
      '<path d="M16 21v-3a2 2 0 0 1 2-2h3" />',

    'grid-3x3':
      '<rect width="18" height="18" x="3" y="3" rx="2" />' +
      '<path d="M3 9h18" />' +
      '<path d="M3 15h18" />' +
      '<path d="M9 3v18" />' +
      '<path d="M15 3v18" />',

    'message-square':
      '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />',

    'code':
      '<path d="m16 18 6-6-6-6" />' +
      '<path d="m8 6-6 6 6 6" />',

    'help-circle':
      '<circle cx="12" cy="12" r="10" />' +
      '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />' +
      '<path d="M12 17h.01" />',

    'lightbulb':
      '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />' +
      '<path d="M9 18h6" />' +
      '<path d="M10 22h4" />',

    'check':
      '<path d="M20 6 9 17l-5-5" />',

    'alert-triangle':
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />' +
      '<path d="M12 9v4" />' +
      '<path d="M12 17h.01" />',

    'user':
      '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />' +
      '<circle cx="12" cy="7" r="4" />',

    'users':
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />' +
      '<path d="M16 3.128a4 4 0 0 1 0 7.744" />' +
      '<path d="M22 21v-2a4 4 0 0 0-3-3.87" />' +
      '<circle cx="9" cy="7" r="4" />',

    'flame':
      '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" />',

    'cat':
      '<path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z" />' +
      '<path d="M8 14v.5" />' +
      '<path d="M16 14v.5" />' +
      '<path d="M11.25 16.25h1.5L12 17l-.75-.75Z" />',

    'swords':
      '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />' +
      '<line x1="13" x2="19" y1="19" y2="13" />' +
      '<line x1="16" x2="20" y1="16" y2="20" />' +
      '<line x1="19" x2="21" y1="21" y2="19" />' +
      '<polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5" />' +
      '<line x1="5" x2="9" y1="14" y2="18" />' +
      '<line x1="7" x2="4" y1="17" y2="20" />' +
      '<line x1="3" x2="5" y1="19" y2="21" />',

    'clock':
      '<circle cx="12" cy="12" r="10" />' +
      '<path d="M12 6v6l4 2" />',

    'refresh-cw':
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />' +
      '<path d="M21 3v5h-5" />' +
      '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />' +
      '<path d="M8 16H3v5" />',

    'search':
      '<path d="m21 21-4.34-4.34" />' +
      '<circle cx="11" cy="11" r="8" />',

    'filter':
      '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />',

    'chevron-down':
      '<path d="m6 9 6 6 6-6" />',

    'chevron-up':
      '<path d="m18 15-6-6-6 6" />'
  };

  // ── icon(name, size?) → complete inline SVG string ──
  function icon(name, size) {
    var s = size || 16;
    var paths = ICONS[name];
    if (!paths) {
      console.warn('[PixelIcons] Unknown icon: ' + name);
      return '';
    }
    return '<svg class="icon" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  // ── Public API ──
  window.PixelIcons = {
    ICONS: ICONS,
    icon: icon
  };

})();
