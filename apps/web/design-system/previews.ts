import type { ComponentType } from 'react';
import { AnimeSchedulePreview } from './anime-schedule-preview';
import { ButtonsPreview, ConfirmationPreview, DownloadVisibilityPreview, FeedbackPreview, FieldsPreview, FilterPattern, FormPattern, NextEpisodeLeadPattern, NumberStepperPreview, PlayerFeedbackPreview, PlayerQualityPreview, PlayerShortcutsPreview, SegmentedPreview, SelectPreview, SheetPreview, SubtitleCompatibilityPreview, TogglePreview } from './preview-components';

// Markdown selects registered components without evaluating source code.
export const previews: Record<string, ComponentType> = {
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
  'player-quality': PlayerQualityPreview,
  'subtitle-compatibility': SubtitleCompatibilityPreview,
  'download-visibility': DownloadVisibilityPreview,
  'number-stepper': NumberStepperPreview,
  'next-episode-lead': NextEpisodeLeadPattern,
};
