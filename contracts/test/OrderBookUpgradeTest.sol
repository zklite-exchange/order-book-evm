// SPDX-License-Identifier: GPL-3.0
import {OrderBook} from "../OrderBook.sol";

import "hardhat/console.sol";

contract OrderBookUpgradeTest is OrderBook {
    /**
    * @custom:oz-upgrades-unsafe-allow constructor
    */
    constructor(string memory name, string memory version) OrderBook(name, version) initializer {
    }

    function onUpgrade() public reinitializer(2) {
        console.log("%s %s", getName(), getVersion());
    }
}
