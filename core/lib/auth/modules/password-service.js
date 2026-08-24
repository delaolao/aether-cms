/**
 * Service for password hashing and verification.
 *
 * Uses Node's built-in crypto.scrypt (pure JS + OpenSSL, no native npm
 * dependency). This replaces the previous argon2 implementation because
 * argon2 ships prebuilt binaries that require a recent glibc (2.34+), which
 * fails on older Linux distributions (CentOS 7/8, Debian 11, Ubuntu 20.04,
 * ...) and ARM servers.
 *
 * Stored hash format (self-describing, PHC-like):
 *   scrypt$N$r$p$<salt hex>$<derived key hex>
 *
 * Verify parses the stored parameters, so increasing the cost factors later
 * does not break existing hashes.
 */
import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scrypt = promisify(scryptCallback)

// Default cost parameters: N=2^15, r=8 → ~32 MiB memory, ~30–50 ms per hash.
// OpenSSL's scrypt needs 128*r*(N+2) bytes of memory, which slightly exceeds
// Node's default 32 MiB maxmem, so maxmem must be raised explicitly.
const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1, keylen: 64 }
const SALT_BYTES = 16
const MAXMEM = 64 * 1024 * 1024 // 64 MiB cap for hashing

// Upper bounds for parameters read back from stored hashes (defense against
// tampered/corrupt hashes requesting absurd amounts of memory).
const MAX_N = 1 << 18 // 262144 → 128*8*(262144+2) ≈ 256 MiB
const MAX_R = 32
const MAX_P = 8

export class PasswordService {
    /**
     * Hash a password using scrypt (salt is generated internally and included
     * in the returned string).
     * @param {string} password - Password to hash
     * @returns {Promise<string>} - Hashed password
     */
    async hashPassword(password) {
        try {
            const salt = randomBytes(SALT_BYTES)
            const { N, r, p, keylen } = SCRYPT_DEFAULTS
            const derivedKey = await scrypt(password, salt, keylen, { N, r, p, maxmem: MAXMEM })

            return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derivedKey.toString("hex")}`
        } catch (error) {
            console.error("Error hashing password:", error)
            throw error
        }
    }

    /**
     * Verify a password against a stored hash.
     * @param {string} password - Password to verify
     * @param {string} hash - Stored hash (scrypt$... format; legacy argon2
     *                        hashes simply fail verification)
     * @returns {Promise<boolean>} - True if password matches
     */
    async verifyPassword(password, hash) {
        try {
            if (typeof hash !== "string") return false

            const parts = hash.split("$")
            // Legacy argon2 hashes start with "$argon2..." — not our format.
            if (parts.length !== 6 || parts[0] !== "scrypt") return false

            const N = parseInt(parts[1], 10)
            const r = parseInt(parts[2], 10)
            const p = parseInt(parts[3], 10)
            const salt = Buffer.from(parts[4], "hex")
            const expected = Buffer.from(parts[5], "hex")

            if (!N || !r || !p || N > MAX_N || r > MAX_R || p > MAX_P) return false
            if (salt.length === 0 || expected.length === 0) return false

            // Allow the exact memory the stored params require (plus headroom).
            const maxmem = 128 * r * (N + 2) + 1024
            const derivedKey = await scrypt(password, salt, expected.length, { N, r, p, maxmem })
            return timingSafeEqual(derivedKey, expected)
        } catch (error) {
            console.error("Error verifying password:", error)
            return false
        }
    }
}
