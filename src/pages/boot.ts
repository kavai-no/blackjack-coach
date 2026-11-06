import { mountNewShoePage } from "./new-shoe-page.ts";

mountNewShoePage(document, (message) => window.confirm(message));
