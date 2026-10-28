// Prefs that cranez.sh writes into Zen on `install` (Zen must be quit).
// Applied once per install; later changes in about:config stick.
// To carry tuned values to another Mac: tune them in about:config, quit Zen,
// run `./cranez.sh capture`, commit, then `./cranez.sh install` on the other Mac.
user_pref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true);
