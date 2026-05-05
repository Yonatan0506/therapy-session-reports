# הקלטה כשהמסך סגור באנדרואיד

## למה צריך אפליקציית Android

אתר/PWA בדפדפן Android לא יכול להבטיח הקלטה יציבה כשהמסך נעול. Chrome עשוי לעצור או לעכב פעילות רקע.

כדי להקליט כשהמסך כבוי צריך אפליקציית Android עם:

- הרשאת מיקרופון `RECORD_AUDIO`
- Foreground Service
- סוג שירות קדמי `microphone`
- הרשאת `FOREGROUND_SERVICE_MICROPHONE`
- התראה קבועה בזמן ההקלטה

זה תואם לדרישות Android העדכניות לשירות קדמי שמשתמש במיקרופון.

## מה כבר נוסף לפרויקט

- Capacitor Android wrapper.
- קובץ `capacitor.config.ts`.
- תיקיית `android`.
- הרשאות Android במניפסט.
- שירות Native:
  `ForegroundRecordingService`
- Plugin:
  `NativeRecorder`
- באפליקציית Android, כפתור ההקלטה ינסה להשתמש ב-NativeRecorder.
- בדפדפן רגיל, ההקלטה תמשיך להשתמש ב-MediaRecorder.

## מה צריך להתקין במחשב כדי לבנות APK

1. Android Studio:
   https://developer.android.com/studio

2. בזמן ההתקנה לוודא שמותקנים:
   - Android SDK
   - Android SDK Platform
   - Android SDK Build-Tools
   - Android Emulator, לא חובה אם בודקים על טלפון אמיתי
   - JDK שמגיע עם Android Studio

3. אחרי ההתקנה, צריך שפקודת Java תהיה זמינה או להגדיר `JAVA_HOME`.

## איך לפתוח את הפרויקט ב-Android Studio

בתיקיית הפרויקט מריצים:

```powershell
npm.cmd run android:open
```

או פותחים ידנית ב-Android Studio את התיקייה:

```text
C:\Users\yonat\OneDrive\Desktop\תמלול\android
```

## איך לבנות APK לבדיקה

אחרי ש-Android Studio מותקן:

```powershell
cd "C:\Users\yonat\OneDrive\Desktop\תמלול"
npm.cmd run android:sync
cd android
.\gradlew.bat assembleDebug
```

ה-APK יופיע בדרך כלל כאן:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## איך לבדוק בטלפון אמיתי

1. מחברים טלפון Android עם כבל USB.
2. מפעילים Developer Options בטלפון.
3. מפעילים USB debugging.
4. ב-Android Studio לוחצים Run.
5. מאשרים הרשאות מיקרופון והתראות.
6. מתחילים הקלטה באפליקציה.
7. מכבים מסך.
8. אחרי כמה דקות מדליקים מסך ועוצרים הקלטה.
9. לוחצים הפק דוח.

## מגבלה חשובה

זהו שלב ראשון של Native recording. צריך לבדוק בפועל על מכשיר Android אמיתי, כי יצרני טלפונים שונים מנהלים סוללה ורקע בצורה שונה.

אם הטלפון הורג שירותים ברקע, ייתכן שצריך לבטל Battery Optimization לאפליקציה.

