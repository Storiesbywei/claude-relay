/**
 * Scan-then-Seal Client-Side Encryption (Browser)
 *
 * AES-256-GCM symmetric encryption using the Web Crypto API.
 * Session key derived from shared secret via HKDF.
 *
 * Key lifecycle:
 *   1. Creator generates secret -> embedded in URL fragment (#key=...)
 *   2. HKDF derives AES-256-GCM key from secret + session ID salt
 *   3. Content scanner runs BEFORE encryption
 *   4. Each message encrypted with fresh random 12-byte IV
 *   5. Server stores only ciphertext — cannot read messages
 *   6. Recipients decrypt with the same derived key
 *
 * The session key lives in memory ONLY — never in localStorage.
 * The URL fragment (#key=...) is never sent to the server by browsers.
 */

// ─── Encoding Helpers ────────────────────────────────────────────────────────

function bufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(b64) {
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToHex(buffer) {
  var bytes = new Uint8Array(buffer);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── URL-Safe Base64 ─────────────────────────────────────────────────────────

function toUrlSafeBase64(buffer) {
  return bufferToBase64(buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromUrlSafeBase64(urlSafe) {
  var b64 = urlSafe.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  return base64ToBuffer(b64);
}

// ─── Secret Generation ───────────────────────────────────────────────────────

function generateSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ─── Key Derivation (HKDF) ──────────────────────────────────────────────────

async function deriveSessionKey(secret, sessionId) {
  var keyMaterial = await crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveKey']
  );

  var salt = new TextEncoder().encode(sessionId);
  var info = new TextEncoder().encode('claude-relay-e2e');

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// ─── Key Fingerprint ─────────────────────────────────────────────────────────

async function getKeyFingerprint(key) {
  var raw = await crypto.subtle.exportKey('raw', key);
  var hash = await crypto.subtle.digest('SHA-256', raw);
  var full = bufferToHex(hash);
  return { short: full.slice(0, 8), full: full };
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

async function encryptMessage(plaintext, key) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var encoded = new TextEncoder().encode(plaintext);

  var ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoded
  );

  return {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    encrypted: true
  };
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────

async function decryptMessage(payload, key) {
  var ciphertextBuffer = base64ToBuffer(payload.ciphertext);
  var iv = base64ToBuffer(payload.iv);

  var plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    ciphertextBuffer
  );

  return new TextDecoder().decode(plaintextBuffer);
}

// ─── Payload Detection ───────────────────────────────────────────────────────

function parseEncryptedContent(content) {
  try {
    var parsed = JSON.parse(content);
    if (parsed && parsed.encrypted === true &&
        typeof parsed.ciphertext === 'string' &&
        typeof parsed.iv === 'string') {
      return parsed;
    }
  } catch (e) {
    // Not JSON — plaintext
  }
  return null;
}

// ─── Client-Side Content Scanner ─────────────────────────────────────────────
// Mirrors the server-side scanner patterns from constants.ts / scanner.ts.
// Runs BEFORE encryption so sensitive content is caught at the source.

var SENSITIVE_PATTERNS = [
  /\b(sk-[a-zA-Z0-9-]{20,})/,
  /\b(ghp_[a-zA-Z0-9]{36,})/,
  /\b(AKIA[A-Z0-9]{16})/,
  /\b(xox[bpsa]-[a-zA-Z0-9-]+)/,
  /password\s*[:=]\s*["'][^"']+["']/i,
  /secret\s*[:=]\s*["'][^"']+["']/i,
  /api[_-]?key\s*[:=]\s*["'][^"']+["']/i,
  /\/Users\/[a-zA-Z0-9_-]+\//,
  /\/home\/[a-zA-Z0-9_-]+\//,
  /[A-Z]:\\/,
  /nsec1[a-z0-9]{56,}/,
  /^[0-9a-f]{64}$/m,
];

var INVISIBLE_CHARS = [
  /[\u200B-\u200F]/g,
  /[\u2028-\u2029]/g,
  /[\u2060-\u2064]/g,
  /[\uFEFF]/g,
  /[\u00AD]/g,
  /[\u034F]/g,
  /[\u061C]/g,
  /[\u115F-\u1160]/g,
  /[\u17B4-\u17B5]/g,
  /[\u180E]/g,
  /[\u3164]/g,
  /[\uFFA0]/g,
];

var BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;
var MD_IMAGE_EXFIL = /!\[[^\]]*\]\(https?:\/\/[^)]*[?&][A-Za-z0-9+/=]{20,}/;

function clientSideScan(content) {
  var warnings = [];

  // Strip invisible Unicode
  var clean = content;
  var strippedCount = 0;
  for (var i = 0; i < INVISIBLE_CHARS.length; i++) {
    var matches = clean.match(INVISIBLE_CHARS[i]);
    if (matches) strippedCount += matches.length;
    clean = clean.replace(INVISIBLE_CHARS[i], '');
  }
  if (strippedCount > 5) {
    warnings.push(strippedCount + ' invisible Unicode character(s) stripped');
  }

  // Bidi overrides
  if (BIDI_OVERRIDES.test(content)) {
    warnings.push('Bidirectional text override characters detected');
  }

  // Sensitive patterns
  for (var j = 0; j < SENSITIVE_PATTERNS.length; j++) {
    var match = clean.match(SENSITIVE_PATTERNS[j]);
    if (match) {
      var matched = match[0];
      var redacted = matched.length > 10
        ? matched.slice(0, 6) + '...' + matched.slice(-4)
        : matched;
      warnings.push('Potential sensitive content: "' + redacted + '"');
    }
  }

  // Large base64 blobs
  if (/[A-Za-z0-9+/=]{1024,}/.test(clean)) {
    warnings.push('Large base64-encoded blob detected');
  }

  // Markdown exfiltration
  if (MD_IMAGE_EXFIL.test(clean)) {
    warnings.push('Potential data exfiltration via Markdown image URL');
  }

  return { warnings: warnings, hasSensitive: warnings.length > 0 };
}

// ─── Relay Crypto Manager ────────────────────────────────────────────────────
// Manages the encryption state for the current session.
// Key lives in memory only — never persisted to localStorage.

var relayCrypto = {
  /** @type {CryptoKey|null} */
  _sessionKey: null,
  /** @type {string|null} */
  _fingerprint: null,
  /** @type {boolean} */
  enabled: false,

  /**
   * Initialize encryption for session creation.
   * Generates a new secret, derives the key, returns the URL-safe secret.
   * @param {string} sessionId
   * @returns {Promise<string>} URL-safe base64 encoded secret for URL fragment
   */
  async initForCreator(sessionId) {
    var secret = generateSecret();
    this._sessionKey = await deriveSessionKey(secret, sessionId);
    var fp = await getKeyFingerprint(this._sessionKey);
    this._fingerprint = fp.short;
    this.enabled = true;
    this._storeSecret(secret);
    this._keyVersion = 1;
    this._keyHistory = [];
    return toUrlSafeBase64(secret.buffer);
  },

  /**
   * Initialize encryption for joining a session.
   * Derives the key from the secret extracted from the URL fragment.
   * @param {string} secretB64 URL-safe base64 encoded secret
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async initForJoiner(secretB64, sessionId) {
    var secretBuffer = fromUrlSafeBase64(secretB64);
    var secret = new Uint8Array(secretBuffer);
    this._sessionKey = await deriveSessionKey(secret, sessionId);
    var fp = await getKeyFingerprint(this._sessionKey);
    this._fingerprint = fp.short;
    this.enabled = true;
    this._storeSecret(secret);
    this._keyVersion = 1;
    this._keyHistory = [];
  },

  /**
   * Encrypt a message payload. Runs client-side scanner first.
   * @param {string} content Plaintext content
   * @returns {Promise<{content: string, encrypted: boolean, scanResult: object}>}
   */
  async seal(content) {
    if (!this.enabled || !this._sessionKey) {
      return { content: content, encrypted: false, scanResult: { warnings: [], hasSensitive: false } };
    }

    // Scan-then-Seal: scanner runs BEFORE encryption
    var scanResult = clientSideScan(content);

    var payload = await encryptMessage(content, this._sessionKey);
    return {
      content: JSON.stringify(payload),
      encrypted: true,
      scanResult: scanResult,
    };
  },

  /**
   * Decrypt a message content string.
   * Returns plaintext if encrypted, or the original string if not.
   * @param {string} content
   * @param {boolean} isEncrypted Whether the message has the encrypted flag
   * @returns {Promise<{text: string, wasEncrypted: boolean, error: string|null}>}
   */
  async unseal(content, isEncrypted) {
    if (!isEncrypted || !this.enabled || !this._sessionKey) {
      return { text: content, wasEncrypted: false, error: null };
    }

    var payload = parseEncryptedContent(content);
    if (!payload) {
      return { text: content, wasEncrypted: false, error: null };
    }

    try {
      var plaintext = await decryptMessage(payload, this._sessionKey);
      return { text: plaintext, wasEncrypted: true, error: null };
    } catch (e) {
      return {
        text: '[Decryption failed — wrong key or corrupted message]',
        wasEncrypted: true,
        error: e.message || 'Decryption failed',
      };
    }
  },

  /** Get the short fingerprint for UI display */
  getFingerprint() {
    return this._fingerprint;
  },

  /** Clear encryption state (on session end).
   * Zeroizes secret material in memory (best-effort — JS GC may retain copies). */
  clear() {
    // Zeroize the raw secret before releasing
    if (this._currentSecret) {
      this._currentSecret.fill(0);
    }
    this._sessionKey = null;
    this._fingerprint = null;
    this.enabled = false;
    this._keyVersion = 1;
    this._keyHistory = [];
    this._currentSecret = null;
  },

  // ─── Capability Lattice: Key Rotation ───────────────────────────────────

  /** @type {number} Current key version */
  _keyVersion: 1,
  /** @type {Array<{version: number, key: CryptoKey}>} Key history (humans keep all versions) */
  _keyHistory: [],
  /** @type {Uint8Array|null} Current raw secret for key rotation */
  _currentSecret: null,

  /**
   * Rotate the session key for an agent invite or revocation.
   * Derives a new key version from the current secret + a random nonce.
   *
   * After rotation:
   * - The new key version is used for all future messages
   * - The old key is preserved in _keyHistory for decrypting old messages
   * - The nonce is returned so it can be shared with participants
   *
   * @param {string} sessionId
   * @param {string} reason - 'agent_invite' | 'agent_revoke' | 'manual'
   * @returns {Promise<{nonce: string, version: number, fingerprint: string}>}
   */
  async rotateKey(sessionId, reason) {
    if (!this._currentSecret || !this._sessionKey) {
      throw new Error('Cannot rotate key: no active session key');
    }

    // Save the current key in history before rotating
    this._keyHistory.push({
      version: this._keyVersion,
      key: this._sessionKey,
    });

    // Generate a random 32-byte nonce
    var nonce = crypto.getRandomValues(new Uint8Array(32));

    // Concatenate current secret + nonce
    var combined = new Uint8Array(this._currentSecret.length + nonce.length);
    combined.set(this._currentSecret, 0);
    combined.set(nonce, this._currentSecret.length);

    // Hash to get new 32-byte secret
    var hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    var newSecret = new Uint8Array(hashBuffer);

    // Increment version
    this._keyVersion++;

    // Derive new key with version-tagged info
    var keyMaterial = await crypto.subtle.importKey(
      'raw', newSecret, 'HKDF', false, ['deriveKey']
    );
    var salt = new TextEncoder().encode(sessionId);
    var info = new TextEncoder().encode('claude-relay-e2e:v' + this._keyVersion);

    this._sessionKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    this._currentSecret = newSecret;

    var fp = await getKeyFingerprint(this._sessionKey);
    this._fingerprint = fp.short;

    return {
      nonce: toUrlSafeBase64(nonce.buffer),
      version: this._keyVersion,
      fingerprint: fp.short,
      // The raw new secret (for creating key grants)
      secret: newSecret,
    };
  },

  /**
   * Create an encrypted key grant for an agent.
   * Encrypts the current session secret with a wrapping key derived from a PSK.
   *
   * @param {string} psk - Pre-shared key (e.g., from agent config)
   * @param {string} agentId - Agent identifier
   * @returns {Promise<string>} Base64-encoded encrypted grant
   */
  async createKeyGrant(psk, agentId) {
    if (!this._currentSecret) {
      throw new Error('Cannot create key grant: no active session');
    }

    // Derive wrapping key from PSK + agent ID
    var pskBytes = new TextEncoder().encode(psk);
    var wrapMaterial = await crypto.subtle.importKey(
      'raw', pskBytes, 'HKDF', false, ['deriveKey']
    );
    var wrapSalt = new TextEncoder().encode(agentId);
    var wrapInfo = new TextEncoder().encode('claude-relay-key-grant');

    var wrappingKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: wrapSalt, info: wrapInfo },
      wrapMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    // Encrypt the session secret
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      wrappingKey,
      this._currentSecret
    );

    // Pack IV + ciphertext
    var packed = new Uint8Array(12 + ciphertext.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ciphertext), 12);

    return bufferToBase64(packed.buffer);
  },

  /**
   * Decrypt a message that may be encrypted with an older key version.
   * Tries the current key first, then falls back to key history.
   *
   * @param {string} content
   * @param {boolean} isEncrypted
   * @returns {Promise<{text: string, wasEncrypted: boolean, error: string|null, keyVersion: number|null}>}
   */
  async unsealWithHistory(content, isEncrypted) {
    if (!isEncrypted || !this.enabled || !this._sessionKey) {
      return { text: content, wasEncrypted: false, error: null, keyVersion: null };
    }

    var payload = parseEncryptedContent(content);
    if (!payload) {
      return { text: content, wasEncrypted: false, error: null, keyVersion: null };
    }

    // Try current key first
    try {
      var plaintext = await decryptMessage(payload, this._sessionKey);
      return { text: plaintext, wasEncrypted: true, error: null, keyVersion: this._keyVersion };
    } catch (e) {
      // Current key failed — try history (newest to oldest)
    }

    // Try historical keys
    for (var i = this._keyHistory.length - 1; i >= 0; i--) {
      try {
        var pt = await decryptMessage(payload, this._keyHistory[i].key);
        return { text: pt, wasEncrypted: true, error: null, keyVersion: this._keyHistory[i].version };
      } catch (e2) {
        // This key didn't work either — try next
      }
    }

    return {
      text: '[Decryption failed — no matching key version]',
      wasEncrypted: true,
      error: 'No matching key version',
      keyVersion: null,
    };
  },

  /** Get current key version */
  getKeyVersion() {
    return this._keyVersion;
  },

  /**
   * Store the current secret so we can use it for key rotation later.
   * Called during initForCreator/initForJoiner.
   */
  _storeSecret(secret) {
    this._currentSecret = new Uint8Array(secret);
  },
};
