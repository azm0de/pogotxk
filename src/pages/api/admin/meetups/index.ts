/**
 * Community meetups — the thing that replaces editing meetup.js every week.
 *
 * Times arrive as wall-clock strings plus a zone and are stored as UTC
 * instants, so "6 PM Wednesday" stays 6 PM across the CST/CDT switch.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ApiError, handler, json, readJson, requireRole } from '~/lib/api';
import { recordAudit } from '~/lib/db/audit';
import { uniqueSlugInTable } from '~/lib/slug';
import { DEFAULT_TZ, zonedToUtc } from '~/lib/time';

export const prerender = false;

export const meetupInput = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  descriptionMd: z.string().trim().max(5000).nullable().optional(),
  /** Wall-clock, as produced by <input type="datetime-local">. */
  startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:MM'),
  endsAtLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/)
    .nullable()
    .optional(),
  tz: z.string().min(1).default(DEFAULT_TZ),
  poiId: z.number().int().positive().nullable().optional(),
  locationText: z.string().trim().max(200).nullable().optional(),
  campfireUrl: z.string().url().max(500).nullable().optional().or(z.literal('')),
  recurrenceRule: z.string().trim().max(300).nullable().optional(),
  status: z.enum(['draft', 'published', 'cancelled']).optional(),
});

export const GET = handler(async (ctx: APIContext) => {
  requireRole(ctx, 'ambassador');

  const rows = await env.DB.prepare(
    `SELECT m.id, m.slug, m.title, m.description_md, m.starts_at, m.ends_at, m.tz,
            m.poi_id, m.location_text, m.campfire_url, m.recurrence_rule, m.status,
            m.updated_at, p.name AS poi_name
       FROM meetups m
       LEFT JOIN pois p ON p.id = m.poi_id
      ORDER BY m.starts_at DESC`,
  ).all();

  return json({ meetups: rows.results, count: rows.results.length });
});

export const POST = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const input = await readJson(ctx, meetupInput);

  let startsAt: string;
  let endsAt: string | null = null;
  try {
    startsAt = zonedToUtc(input.startsAtLocal, input.tz);
    if (input.endsAtLocal) endsAt = zonedToUtc(input.endsAtLocal, input.tz);
  } catch (err) {
    throw new ApiError(422, err instanceof Error ? err.message : 'Invalid date');
  }

  if (endsAt && endsAt <= startsAt) throw new ApiError(422, 'End time must be after the start time');

  const zoneId = (
    await env.DB.prepare(
      'SELECT id FROM zones ORDER BY is_default DESC, sort, id LIMIT 1',
    ).first<{ id: number }>()
  )?.id;

  const slug = await uniqueSlugInTable(env.DB, 'meetups', `${input.title}-${startsAt.slice(0, 10)}`);

  const row = await env.DB.prepare(
    `INSERT INTO meetups (zone_id, slug, title, description_md, starts_at, ends_at, tz,
                          poi_id, location_text, campfire_url, recurrence_rule, status, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     RETURNING id`,
  )
    .bind(
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
      input.recurrenceRule ?? null,
      input.status ?? 'draft',
      user.id,
    )
    .first<{ id: number }>();

  if (!row) throw new ApiError(500, 'Insert did not return an id');

  await recordAudit(env.DB, {
    actorId: user.id,
    action: 'create',
    entity: 'meetup',
    entityId: row.id,
    diff: { title: input.title, startsAt },
  });

  return json({ id: row.id, slug, startsAt, endsAt }, 201);
});
