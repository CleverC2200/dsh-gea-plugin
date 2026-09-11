declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const url: string;
  export default url;
}
