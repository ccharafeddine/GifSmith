import mark from "./mark.svg";

/** Smith v2 wordmark: the family mark (violet frame, cyan spark, gif glyph)
 *  plus "Gif" in the app hue and "Smith" in text colour. See docs/design-system.md in MediaSmith. */
export default function Wordmark() {
  return (
    <span class="sm-wordmark" role="img" aria-label="GifSmith">
      <img src={mark} alt="" width="26" height="26" />
      <span aria-hidden="true"><span class="wm-app">Gif</span><span class="wm-smith">Smith</span></span>
    </span>
  );
}
