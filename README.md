# Job Log

A to-do list that keeps a dated log of finished jobs. One list, synced between an Android app and a desktop web app through Firebase.

- **To do:** add jobs, mark them Urgent, set a due time (your phone reminds you), edit or delete.
- **Done log:** ticked jobs are stamped with the time and grouped by day.
- **Offline:** works without internet and syncs when you reconnect.

## Get the app
- **Android:** open the repo's **Releases** page on your phone, download `JobLog.apk`, and open it to install. Allow "install unknown apps" for your browser if asked.
- **Desktop:** `https://<your-username>.github.io/job-log/`

Every push to `main` rebuilds both.

## Signing in
- The Firebase config is built in (`www/config.js`), so there is nothing to paste.
- **Keep me signed in** (on by default) keeps you signed in until you sign out.
- **Desktop:** Chrome and Edge offer to save your password after you sign in.
- **Android:** after your first sign-in the app offers fingerprint unlock. Your password is stored in the phone's secure keystore, unlocked by your fingerprint.

The APK is signed with the fixed key in `signing/`, so each new build installs over the previous one.

## Firebase rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid}/{doc=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```
