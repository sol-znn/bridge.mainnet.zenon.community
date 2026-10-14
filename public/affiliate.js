// Kept from the original deployment so links of the form
  // affiliate.html?referral=<code>&originURL=<url> keep working: the code is
  // stored as is (mangled hex, see src/core/referral.ts) unless one is already
  // stored, and the browser is sent on to originURL.
  //
  // Only this deployment's origin is allowed. Legacy links may select a path
  // here, but cannot send a visitor to an unrelated wallet-looking site.
  ;(function () {
    var params = new URLSearchParams(location.search)
    var code = params.get('referral') || ''
    var origin = params.get('originURL') || ''
    try {
      if (/^[0-9a-f]{2,128}$/i.test(code) && !localStorage.getItem('znn-referral-code')) {
        localStorage.setItem('znn-referral-code', code)
      }
    } catch (e) {}
    try {
      var to = new URL(origin, location.href)
      if (origin && to.origin === location.origin && !to.username && !to.password && (to.protocol === 'https:' || to.protocol === 'http:')) location.replace(to.href)
      else location.replace('./')
    } catch (e) { location.replace('./') }
  })()
