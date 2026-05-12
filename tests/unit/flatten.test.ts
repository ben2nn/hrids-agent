import { describe, it, expect } from 'vitest'
import {
  analyzeSchema,
  flattenSchema,
  nestArguments,
  hasDotKey,
  type JsonSchemaNode,
} from '../../src/core/flatten.js'

describe('flatten', () => {
  describe('analyzeSchema', () => {
    it('undefined schema returns no-flatten', () => {
      const result = analyzeSchema(undefined)
      expect(result).toEqual({ shouldFlatten: false, leafCount: 0, maxDepth: 0 })
    })

    it('flat schema with few leaves does not need flattening', () => {
      const schema: JsonSchemaNode = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      }
      const result = analyzeSchema(schema)
      expect(result.shouldFlatten).toBe(false)
      expect(result.leafCount).toBe(2)
      expect(result.maxDepth).toBe(1)
    })

    it('deeply nested schema needs flattening (depth > 2)', () => {
      const schema: JsonSchemaNode = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              profile: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                },
              },
            },
          },
        },
      }
      const result = analyzeSchema(schema)
      expect(result.shouldFlatten).toBe(true)
      expect(result.maxDepth).toBe(3)
    })

    it('wide schema needs flattening (leaves > 10)', () => {
      const props: Record<string, JsonSchemaNode> = {}
      for (let i = 0; i < 12; i++) {
        props[`field${i}`] = { type: 'string' }
      }
      const schema: JsonSchemaNode = { type: 'object', properties: props }
      const result = analyzeSchema(schema)
      expect(result.shouldFlatten).toBe(true)
      expect(result.leafCount).toBe(12)
    })

    it('array items increase depth', () => {
      const schema: JsonSchemaNode = {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      }
      const result = analyzeSchema(schema)
      expect(result.leafCount).toBe(1)
      expect(result.maxDepth).toBe(2)
    })
  })

  describe('flattenSchema', () => {
    it('flattens nested object to dot paths', () => {
      const schema: JsonSchemaNode = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number' },
            },
            required: ['name'],
          },
        },
        required: ['user'],
      }
      const flat = flattenSchema(schema)
      expect(flat.type).toBe('object')
      expect(flat.properties).toHaveProperty('user.name')
      expect(flat.properties).toHaveProperty('user.age')
      expect(flat.properties!['user.name']).toEqual({ type: 'string' })
      expect(flat.required).toContain('user.name')
      expect(flat.required).not.toContain('user.age')
    })

    it('treats arrays as opaque leaves', () => {
      const schema: JsonSchemaNode = {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      }
      const flat = flattenSchema(schema)
      expect(flat.properties).toHaveProperty('tags')
      expect(flat.properties!['tags'].type).toBe('array')
    })

    it('preserves required chain through nesting', () => {
      const schema: JsonSchemaNode = {
        type: 'object',
        properties: {
          a: {
            type: 'object',
            properties: {
              b: {
                type: 'object',
                properties: {
                  c: { type: 'string' },
                },
                required: ['c'],
              },
            },
            required: ['b'],
          },
        },
        required: ['a'],
      }
      const flat = flattenSchema(schema)
      expect(flat.required).toContain('a.b.c')
    })

    it('does not mark leaf as required if parent is optional', () => {
      const schema: JsonSchemaNode = {
        type: 'object',
        properties: {
          a: {
            type: 'object',
            properties: {
              b: { type: 'string' },
            },
            required: ['b'],
          },
        },
        // 'a' is NOT required
      }
      const flat = flattenSchema(schema)
      expect(flat.required).not.toContain('a.b')
    })
  })

  describe('nestArguments', () => {
    it('nests dot-path keys into objects', () => {
      const flat = { 'user.profile.name': 'alice', 'user.profile.age': 30 }
      const nested = nestArguments(flat)
      expect(nested).toEqual({
        user: { profile: { name: 'alice', age: 30 } },
      })
    })

    it('handles single-level keys unchanged', () => {
      const flat = { name: 'alice', age: 30 }
      const nested = nestArguments(flat)
      expect(nested).toEqual({ name: 'alice', age: 30 })
    })

    it('handles mixed depth keys', () => {
      const flat = { 'a.b.c': 1, d: 2 }
      const nested = nestArguments(flat)
      expect(nested).toEqual({ a: { b: { c: 1 } }, d: 2 })
    })
  })

  describe('hasDotKey', () => {
    it('returns true when keys contain dots', () => {
      expect(hasDotKey({ 'a.b': 1 })).toBe(true)
    })

    it('returns false when no keys contain dots', () => {
      expect(hasDotKey({ ab: 1, cd: 2 })).toBe(false)
    })

    it('returns false for empty object', () => {
      expect(hasDotKey({})).toBe(false)
    })
  })
})
