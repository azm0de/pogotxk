/**
 * Community meetups — the thing that replaces editing meetup.js every week.
 *
 * Times arrive as wall-clock strings plus a zone and are stored as UTC
 * instants, so "6 PM Wednesday" stays 6 PM across the CST/CDT switch.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, json, readJson, requireRole, requireRowExists } from '~/lib/api';
import { auditStatement } from '~/lib/db/audit';
import { isUsableRecurrenceRule } from '~/lib/db/meetups';
import { settleAnnouncement } from '~/lib/notify/announcements';
import { isHttpUrl } from '~/lib/safe-url';
import { uniqueSlugInTable } from '~/lib/slug';
import { DEFAULT_TZ, isValidTimeZone, zonedToUtc } from '~/lib/time';

export const prerender = false;

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * Hard ceiling on one read of the admin list, reported in the response with the
 * true total so the console can say when it is showing part of the table
 * (admin audit, 2026-10, B-20).
 */
export const ADMIN_MEETUP_LIST_LIMIT = 1000;

/**
 * Every field as PATCH sees it: all optional, nothing defaulted.
 *
 * The zone used to carry `.default(DEFAULT_TZ)` here, and `.partial()` keeps a
 * default — so every PATCH that did not mention the zone silently reset it to
 * Central. The default now lives only on the POST schema below.
 */
export const meetupFields = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  descriptionMd: z.string().trim().max(5000).nullable().optional(),
  /** Wall-clock, as produced by <input type="datetime-local">. */
  startsAtLocal: z.string().regex(LOCAL_DATETIME, 'Expected YYYY-MM-DDTHH:MM'),
  endsAtLocal: z.string().regex(LOCAL_DATETIME, 'Expected YYYY-MM-DDTHH:MM').nullable().optional(),
  /**
   * Validated against `Intl` itself, which is what renders it later: a zone it
   * does not know used to be stored and then throw on every public page that
   * showed the meetup (admin audit, 2026-10, B-01).
   */
  tz: z.string().trim().refine(isValidTimeZone, 'Unknown time zone'),
  poiId: z.number().int().positive().nullable().optional(),
  locationText: z.string().trim().max(200).nullable().optional(),
  /**
   * `z.string().url()` accepted `javascript:alert(1)`, and this value is an
   * href on the home page (admin audit, 2026-10, B-02). Empty string still
   * means "no link".
   */
  campfireUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || isHttpUrl(v, 500), 'Must be an http(s) link')
    .nullable()
    .optional(),
  /** Must be a rule the events page can actually expand (admin audit, 2026-10, B-24). */
  recurrenceRule: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || isUsableRecurrenceRule(v), 'Not a recurrence rule the calendar understands')
    .nullable()
    .optional(),
  status: z.enum(['draft', 'published', 'cancelled']).optional(),
  /**
   * "Also announce to Discord." A request rather than an instruction — see the
   * same field on `postInput`, and notify/announcements.ts. A `draft` meetup
   * records the request and announces nothing until it is published.
   */
  announce: z.boolean().optional(),
});

export const meetupInput = meetupFields.extend({ tz: meetupFields.shape.tz.default(DEFAULT_TZ) });

/** Turns a refused wall-clock conversion into the author's error, not ours. */
export function toUtcOrThrow(wallClock: string, tz: string): string {
  try {
    return zonedToUtc(wallClock, tz);
  } catch (err) {
    throw new ApiError(422, err instanceof Error ? err.message : 'Invalid date');
  }
}

export const GET = handler(async (ctx: APIContext) => {
  requireRole(ctx, 'ambassador');

  const [rows, total] = await env.DB.batch<never>([
    env.DB.prepare(
      `SELECT m.id, m.slug, m.title, m.description_md, m.starts_at, m.ends_at, m.tz,
              m.poi_id, m.location_text, m.campfire_url, m.recurrence_rule, m.status,
              m.updated_at, m.announce_requested, m.announced_at, p.name AS poi_name
         FROM meetups m
         LEFT JOIN pois p ON p.id = m.poi_id
        ORDER BY m.starts_at DESC
        LIMIT ${ADMIN_MEETUP_LIST_LIMIT}`,
    ),
    env.DB.prepare('SELECT COUNT(*) AS n FROM meetups'),
  ]);

  const meetups = rows.results as unknown[];
  const count = (total.results as unknown as { n: number }[])[0]?.n ?? 0;
  return json({
    meetups,
    count: meetups.length,
    total: count,
    limit: ADMIN_MEETUP_LIST_LIMIT,
    truncated: count > meetups.length,
  });
});

export const POST = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const input = await readJson(ctx, meetupInput);

  const startsAt = toUtcOrThrow(input.startsAtLocal, input.tz);
  const endsAt = input.endsAtLocal ? toUtcOrThrow(input.endsAtLocal, input.tz) : null;

  if (endsAt && endsAt <= startsAt) throw new ApiError(422, 'End time must be after the start time');

  await requireRowExists(env.DB, 'pois', input.poiId, 'poiId');

  const zoneId = (
    await env.DB.prepare(
      'SELECT id FROM zones ORDER BY is_default DESC, sort, id LIMIT 1',
    ).first<{ id: number }>()
  )?.id;

  const slug = await uniqueSlugInTable(env.DB, 'meetups', `${input.title}-${startsAt.slice(0, 10)}`);

  // The row and its audit entry in one transaction (admin audit, 2026-10,
  // B-15). The audit row finds the new id by slug, which is unique.
  const [inserted] = await env.DB.batch<{ id: number }>([
    env.DB.prepare(
      `INSERT INTO meetups (zone_id, slug, title, description_md, starts_at, ends_at, tz,
                            poi_id, location_text, campfire_url, recurrence_rule, status,
                            created_by, announce_requested)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       RETURNING id`,
    ).bind(
      zoneId ?? null,
      slug,
      input.title,
      input.descriptionMd ?? null,
      startsAt,
      endsAt,
      input.tz,
      input.poiId ?? null,
      input.locationText ?? null,
      input.campfireUrl || null,
      input.recurrenceRule || null,
      input.status ?? 'draft',
      user.id,
      input.announce ? 1 : 0,
    ),
    auditStatement(env.DB, {
      actorId: user.id,
      action: 'create',
      entity: 'meetup',
      entityId: { table: 'meetups', column: 'slug', value: slug },
      diff: { title: input.title, startsAt, announce: !!input.announce },
    }),
  ]);

  const id = inserted?.results[0]?.id;
  if (!id) throw new ApiError(500, 'Insert did not return an id');

  const announced = await settleAnnouncement(ctx, env, 'meetups', id, !!input.announce);

  return json({ id, slug, startsAt, endsAt, announced }, 201);
});
