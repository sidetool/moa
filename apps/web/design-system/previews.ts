import { ContinueArtPreview } from './continue-art-preview';
import type { ComponentType } from 'react';
import { TitleRelationsPreview } from './title-relations-preview';
import { AnimeSchedulePreview } from './anime-schedule-preview';
import { TitleOverviewPreview, CatalogRefreshPattern, ButtonsPreview, ConfirmationPreview, DownloadVisibilityPreview, FeedbackPreview, FieldsPreview, FilterPattern, FormPattern, NextEpisodeLeadPattern, NumberStepperPreview, PlaybackExperimentsPreview, PlayerFeedbackPreview, PlayerQualityPreview, PlayerShortcutsPreview, SegmentedPreview, SelectPreview, SheetPreview, SubtitleCompatibilityPreview, TogglePreview } from './preview-components';

// Markdown selects registered components without evaluating source code.
export const previews: Record<string, ComponentType> = {
  'title-relations': TitleRelationsPreview,
  'title-overview': TitleOverviewPreview,
  'catalog-refresh': CatalogRefreshPattern,
  buttons: ButtonsPreview,
  segmented: SegmentedPreview,
  fields: FieldsPreview,
  select: SelectPreview,
  toggle: TogglePreview,
  feedback: FeedbackPreview,
  confirmation: ConfirmationPreview,
  sheet: SheetPreview,
  'form-pattern': FormPattern,
  'filter-pattern': FilterPattern,
  'anime-schedule': AnimeSchedulePreview,
  'player-feedback': PlayerFeedbackPreview,
  'player-shortcuts': PlayerShortcutsPreview,
  'playback-experiments': PlaybackExperimentsPreview,
  'player-quality': PlayerQualityPreview,
  'subtitle-compatibility': SubtitleCompatibilityPreview,
  'download-visibility': DownloadVisibilityPreview,
  'number-stepper': NumberStepperPreview,
  'next-episode-lead': NextEpisodeLeadPattern,
  'continue-art': ContinueArtPreview,
};
