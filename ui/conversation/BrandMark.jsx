import React from 'react';
export default function BrandMark({motion='bell',loop=false,size=40,className='',...props}) {
  const file=motion==='static'?'duolawork-app-primary.svg':`duolawork-${motion==='hand'?'hand-reach':'bell-swing'}-primary-${loop?'loop':'once'}.svg`;
  return <img className={'brand-mark '+className} src={'/brand/'+file} width={size} height={size} alt="DuolaWork" {...props}/>;
}
