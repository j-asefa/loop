export type NotificationPreferences = {
  needsYou: boolean;
  completed: boolean;
  reminders: boolean;
  social: boolean;
};

export const defaultNotificationPreferences: NotificationPreferences = {
  needsYou: true,
  completed: false,
  reminders: false,
  social: false,
};
