CREATE INDEX `tracks_sitemap_indexable_track_id_idx` ON `tracks` (`track_id`) WHERE is_catalogue = 1
      and duplicate_of_track_id is null
      and trim(title) <> ''
      and artists_json is not null and trim(artists_json) not in ('', '[]')
      and dismissed_at is null
      and album_id is not null
      and release_date is not null
      and album_image_url is not null
      and (spotify_url is not null or apple_music_url is not null);