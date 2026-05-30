declare module "dplayer" {
  export default class DPlayer {
    constructor(options: {
      container: HTMLElement;
      video: {
        url: string;
        pic?: string;
        type?: string;
      };
      autoplay?: boolean;
      preload?: string;
      mutex?: boolean;
    });

    destroy(): void;
  }
}
