import { OrderBuilder, ChainId } from '@predictdotfun/sdk';

console.log('OrderBuilder static methods:');
Object.getOwnPropertyNames(OrderBuilder)
    .filter(m => typeof (OrderBuilder as any)[m] === 'function')
    .forEach(m => console.log('  -', m));

console.log('\nOrderBuilder prototype methods:');
Object.getOwnPropertyNames(OrderBuilder.prototype)
    .filter(m => m !== 'constructor')
    .forEach(m => console.log('  -', m));
