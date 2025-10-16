export class SecureStorage {
  private static readonly ALGORITHM = 'AES-GCM';
  private static readonly KEY_LENGTH = 256;
  private static readonly SERVICE_NAME = 'snipd-obsidian-plugin';
  
  private static async deriveKey(vaultPath: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(vaultPath + this.SERVICE_NAME),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    
    const salt = encoder.encode('snipd-secure-storage-salt-v1');
    
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: this.ALGORITHM, length: this.KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  }
  
  static async encryptApiKey(apiKey: string, vaultPath: string): Promise<string> {
    if (!apiKey) {
      return '';
    }
    
    try {
      const key = await this.deriveKey(vaultPath);
      const encoder = new TextEncoder();
      const data = encoder.encode(apiKey);
      
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      const encryptedData = await crypto.subtle.encrypt(
        {
          name: this.ALGORITHM,
          iv: iv
        },
        key,
        data
      );
      
      const encryptedArray = new Uint8Array(encryptedData);
      const combined = new Uint8Array(iv.length + encryptedArray.length);
      combined.set(iv);
      combined.set(encryptedArray, iv.length);
      
      return btoa(String.fromCharCode(...combined));
    } catch (error) {
      console.error('Snipd plugin: Failed to encrypt API key:', error);
      throw new Error('Failed to encrypt API key');
    }
  }
  
  static async decryptApiKey(encryptedApiKey: string, vaultPath: string): Promise<string> {
    if (!encryptedApiKey) {
      return '';
    }
    
    try {
      const key = await this.deriveKey(vaultPath);
      
      const combined = Uint8Array.from(atob(encryptedApiKey), c => c.charCodeAt(0));
      
      const iv = combined.slice(0, 12);
      const encryptedData = combined.slice(12);
      
      const decryptedData = await crypto.subtle.decrypt(
        {
          name: this.ALGORITHM,
          iv: iv
        },
        key,
        encryptedData
      );
      
      const decoder = new TextDecoder();
      return decoder.decode(decryptedData);
    } catch (error) {
      console.error('Snipd plugin: Failed to decrypt API key:', error);
      return '';
    }
  }
}

