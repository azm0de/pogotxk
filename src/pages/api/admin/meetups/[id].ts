import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { ApiError, handler, intParam, json, noContent, readJson, requireRole } from '~/lib/api';
import { diffFields, recordAudit } from '~/lib/db/audit';
import { zonedToUtc } from '~/lib/time';
import { meetupInput } from './index';

export const prerender = false;

const patchInput = meetupInput.partial();

interface MeetupRecord {
  id: number;
  slug: string;
  title: string;
  description_md: string | null;
  starts_at: string;
  ends_at: string | null;
  tz: string;
  poi_id: number | null;
  location_text: string | null;
  campfire_url: string | null;
  recurrence_rule: string | null;
  status: string;
}

async function loadMeetup(id: number): Promise<MeetupRecord> {
  const row = await env.DB.prepare('SELECT * FROM meetups WHERE id = ?1')
    .bind(id)
    .first<MeetupRecord>();
  if (!row) throw new ApiError(404, 'Meetup not found');
  return row;
}

export const PATCH = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const input = await readJson(ctx, patchInput);
  const before = await loadMeetup(id);

  const tz = input.tz ?? before.tz;
  let startsAt = before.starts_at;
  let endsAt = before.ends_at;

  try {
    if (input.startsAtLocal) startsAt = zonedToUtc(input.startsAtLocal, tz);
    if (input.endsAtLocal !== undefined) {
      endsAt = input.endsAtLocal ? zonedToUtc(input.endsAtLocal, tz) : null;
    }
  } catch (err) {
    throw new ApiError(422, err instanceof Error ? err.message : 'Invalid date');
  }

  if (endsAt && endsAt <= startsAt) throw new ApiError(422, 'End time must be after the start time');

  const next = {
    title: input.title ?? before.title,
    description_md: input.descriptionMd === undefined ? before.description_md : input.descriptionMd,
    starts_at: startsAt,
    ends_at: endsAt,
    tz,
    poi_id: input.poiId === undefined ? before.poi_id : input.poiId,
    location_text: input.locationText === undefined ? before.location_text : input.locationText,
    campfire_url:
      input.campfireUrl === undefined ? before.campfire_url : input.campfireUrl || null,
    recurrence_rule:
      input.recurrenceRule === undefined ? before.recurrence_rule : input.recurrenceRule,
    status: input.status ?? before.status,
  };

  await env.DB.prepare(
    `UPDATE meetups SET title = ?2, description_md = ?3, starts_at = ?4, ends_at = ?5, tz = ?6,
                        poi_id = ?7, location_text = ?8, campfire_url = ?9, recurrence_rule = ?10,
                        status = ?11, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?1`,
  )
    .bind(
      id,
      next.title,
      next.description_md,
      next.starts_at,
      next.ends_at,
      next.tz,
      next.poi_id,
      next.location_text,
      next.campfire_url,
      next.recurrence_rule,
      next.status,
    )
    .run();

  const diff = diffFields(before as unknown as Record<string, unknown>, next);
  if (diff) {
    await recordAudit(env.DB, {
      actorId: user.id,
      action: 'update',
      entity: 'meetup',
      entityId: id,
      diff,
    });
  }

  return json({ id, changed: diff !== null, startsAt: next.starts_at });
});

export const DELETE = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const before = await loadMeetup(id);

  await env.DB.prepare('DELETE FROM meetups WHERE id = ?1').bind(id).run();
  await recordAudit(env.DB, {
    actorId: user.id,
    action: 'delete',
    entity: 'meetup',
    entityId: id,
    diff: { title: before.title, startsAt: before.starts_at },
  });

  return noContent();
});
