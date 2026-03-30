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

// ─── Hash Ratchet (Browser) ─────────────────────────────────────────────────
// Per-message forward secrecy using HKDF + AES-256-GCM (Web Crypto API).
// Compatible with the server-side @noble ratchet when using AES-GCM mode.
//
// NOTE: The server-side ratchet uses ChaCha20-Poly1305 via @noble/ciphers.
// This browser version uses AES-256-GCM via Web Crypto for broader compatibility.
// Both sides must use the same cipher — in practice, the browser dashboard
// manages its own ratchet state and never cross-decrypts with the MCP server.

var relayRatchet = {
  /** @type {{chainKey: Uint8Array, messageIndex: number, skippedKeys: Map<number, Uint8Array>, maxSkip: number}|null} */
  _state: null,
  /** @type {string|null} */
  _senderName: null,
  /** @type {boolean} */
  enabled: false,

  /**
   * Initialize the ratchet from a session secret and session ID.
   * @param {Uint8Array} secret - 32-byte session secret
   * @param {string} sessionId
   * @param {string} senderName - Name to embed in sealed sender payloads
   */
  async init(secret, sessionId, senderName) {
    var salt = new TextEncoder().encode(sessionId);
    var info = new TextEncoder().encode('ratchet-init');

    // HKDF-Extract + Expand to derive initial chain key
    var keyMaterial = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    var chainKeyBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
      keyMaterial,
      256
    );

    this._state = {
      chainKey: new Uint8Array(chainKeyBits),
      messageIndex: 0,
      skippedKeys: new Map(),
      maxSkip: 100,
    };
    this._senderName = senderName;
    this.enabled = true;
  },

  /**
   * Step the chain key forward. Returns nextChainKey and messageKey.
   * @param {Uint8Array} chainKey
   * @returns {Promise<{nextChainKey: Uint8Array, messageKey: Uint8Array}>}
   */
  async _stepChainKey(chainKey) {
    var keyMaterial = await crypto.subtle.importKey('raw', chainKey, 'HKDF', false, ['deriveBits']);
    var chainStepInfo = new TextEncoder().encode('chain-step');
    var messageKeyInfo = new TextEncoder().encode('message-key');
    // Use empty salt for HKDF-Expand (chain key is already a PRK)
    var emptySalt = new Uint8Array(0);

    var nextBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: emptySalt, info: chainStepInfo },
      keyMaterial,
      256
    );
    var msgBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: emptySalt, info: messageKeyInfo },
      keyMaterial,
      256
    );

    return {
      nextChainKey: new Uint8Array(nextBits),
      messageKey: new Uint8Array(msgBits),
    };
  },

  /**
   * Encrypt a message with the ratchet (sealed sender: sender name inside payload).
   * @param {string} content
   * @returns {Promise<{content: string, encrypted: boolean}>}
   */
  async seal(content) {
    if (!this.enabled || !this._state) {
      return { content: content, encrypted: false };
    }

    var state = this._state;
    var step = await this._stepChainKey(state.chainKey);
    var currentIndex = state.messageIndex;

    // Zero old chain key, advance state
    state.chainKey.fill(0);
    state.chainKey = step.nextChainKey;
    state.messageIndex++;

    // Sealed sender: embed sender name inside the encrypted content
    var sealedPayload = JSON.stringify({
      sender: this._senderName || 'anonymous',
      content: content,
    });

    // Encrypt with AES-256-GCM
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var aesKey = await crypto.subtle.importKey(
      'raw', step.messageKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    var ciphertextBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      aesKey,
      new TextEncoder().encode(sealedPayload)
    );

    // Zero message key
    step.messageKey.fill(0);

    var ratchetPayload = {
      ciphertext: bufferToBase64(ciphertextBuf),
      iv: bufferToBase64(iv),
      index: currentIndex,
      ratchet: true,
    };

    return {
      content: JSON.stringify(ratchetPayload),
      encrypted: true,
    };
  },

  /**
   * Decrypt a ratchet message. Handles out-of-order delivery.
   * @param {string} content - JSON string containing ratchet payload
   * @param {boolean} isEncrypted
   * @returns {Promise<{text: string, wasEncrypted: boolean, error: string|null, sender: string|null}>}
   */
  async unseal(content, isEncrypted) {
    if (!isEncrypted || !this.enabled || !this._state) {
      return { text: content, wasEncrypted: false, error: null, sender: null };
    }

    var parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return { text: content, wasEncrypted: false, error: null, sender: null };
    }

    if (!parsed || !parsed.ratchet) {
      // Not a ratchet payload — fall back to standard AES-GCM decryption
      return { text: content, wasEncrypted: false, error: null, sender: null };
    }

    var state = this._state;
    var ciphertextBytes = base64ToBuffer(parsed.ciphertext);
    var nonce = base64ToBuffer(parsed.iv);
    var index = parsed.index;
    var messageKey;

    try {
      if (index < state.messageIndex) {
        // Past message — check skipped keys cache
        var cached = state.skippedKeys.get(index);
        if (!cached) {
          return {
            text: '[Ratchet: message key already consumed]',
            wasEncrypted: true,
            error: 'Key consumed',
            sender: null,
          };
        }
        messageKey = cached;
        state.skippedKeys.delete(index);
      } else if (index === state.messageIndex) {
        // Expected next message
        var step = await this._stepChainKey(state.chainKey);
        state.chainKey.fill(0);
        state.chainKey = step.nextChainKey;
        state.messageIndex++;
        messageKey = step.messageKey;
      } else {
        // Future message — skip forward
        var skip = index - state.messageIndex;
        if (skip > state.maxSkip) {
          return {
            text: '[Ratchet: too many skipped messages]',
            wasEncrypted: true,
            error: 'Max skip exceeded',
            sender: null,
          };
        }

        for (var i = state.messageIndex; i < index; i++) {
          var s = await this._stepChainKey(state.chainKey);
          state.chainKey.fill(0);
          state.chainKey = s.nextChainKey;
          state.skippedKeys.set(i, s.messageKey);
        }

        var finalStep = await this._stepChainKey(state.chainKey);
        state.chainKey.fill(0);
        state.chainKey = finalStep.nextChainKey;
        state.messageIndex = index + 1;
        messageKey = finalStep.messageKey;
      }

      // Decrypt
      var aesKey = await crypto.subtle.importKey(
        'raw', messageKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
      );
      var plaintextBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(nonce) },
        aesKey,
        new Uint8Array(ciphertextBytes)
      );

      // Zero the message key
      messageKey.fill(0);

      var plaintext = new TextDecoder().decode(plaintextBuf);

      // Unseal sender
      try {
        var unsealed = JSON.parse(plaintext);
        if (unsealed && typeof unsealed.sender === 'string' && typeof unsealed.content === 'string') {
          return {
            text: unsealed.content,
            wasEncrypted: true,
            error: null,
            sender: unsealed.sender,
          };
        }
      } catch (e2) {
        // Not a sealed sender payload — return raw
      }

      return { text: plaintext, wasEncrypted: true, error: null, sender: null };
    } catch (e) {
      return {
        text: '[Ratchet decryption failed]',
        wasEncrypted: true,
        error: e.message || 'Decryption failed',
        sender: null,
      };
    }
  },

  /**
   * Perform a key update (post-compromise security).
   * Returns the entropy to send to the peer.
   * @returns {Promise<{entropy: string, index: number, key_update: true}>}
   */
  async keyUpdate() {
    if (!this._state) throw new Error('No ratchet state');
    var state = this._state;

    var entropy = crypto.getRandomValues(new Uint8Array(32));
    var currentIndex = state.messageIndex;

    await this._applyKeyUpdate(entropy);

    return {
      entropy: bufferToBase64(entropy),
      index: currentIndex,
      key_update: true,
    };
  },

  /**
   * Apply a key update from a peer.
   * @param {Uint8Array} entropy
   */
  async _applyKeyUpdate(entropy) {
    var state = this._state;
    if (!state) return;

    // Mix entropy with current chain key via HKDF
    var keyMaterial = await crypto.subtle.importKey('raw', entropy, 'HKDF', false, ['deriveBits']);
    var info = new TextEncoder().encode('ratchet-init');
    var newBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: state.chainKey, info: info },
      keyMaterial,
      256
    );

    state.chainKey.fill(0);
    state.chainKey = new Uint8Array(newBits);

    // Clear skipped keys (old epoch)
    for (var entry of state.skippedKeys.values()) {
      entry.fill(0);
    }
    state.skippedKeys.clear();
  },

  /**
   * Clear ratchet state (on session end).
   */
  clear() {
    if (this._state) {
      this._state.chainKey.fill(0);
      for (var entry of this._state.skippedKeys.values()) {
        entry.fill(0);
      }
      this._state.skippedKeys.clear();
      this._state = null;
    }
    this._senderName = null;
    this.enabled = false;
  },

  /** Get current message index */
  getMessageIndex() {
    return this._state ? this._state.messageIndex : 0;
  },
};
